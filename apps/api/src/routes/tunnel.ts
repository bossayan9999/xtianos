import { Router, type Request, type Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../lib/env";
import { audit } from "../lib/auth";

export const tunnelRouter = Router();

interface TunnelMessage {
  id: string;
  from: string;
  to: string;
  type: "command" | "response" | "status" | "query";
  content: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  read: boolean;
}

interface TunnelIndex {
  version: number;
  lastId: number;
  agents: Record<string, { name: string; description: string; status: string }>;
  messages: TunnelMessage[];
}

const MESSAGES_DIR = path.join(env.vaultPath, "BRAIN", "communication", "messages");

async function loadIndex(): Promise<TunnelIndex> {
  const indexPath = path.join(MESSAGES_DIR, "index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    return JSON.parse(raw) as TunnelIndex;
  } catch {
    return {
      version: 1,
      lastId: 0,
      agents: {
        "xtianos-v5": {
          name: "xtianOS v5",
          description: "Dashboard UI and frontend copilot",
          status: "online",
        },
        mjane: {
          name: "mjane",
          description: "Brain copilot and homelab ops agent",
          status: "online",
        },
        copilot: {
          name: "Obsidian Copilot",
          description: "Obsidian Copilot agent running in the vault",
          status: "online",
        },
      },
      messages: [],
    };
  }
}

async function saveIndex(index: TunnelIndex): Promise<void> {
  await fs.mkdir(MESSAGES_DIR, { recursive: true });
  const indexPath = path.join(MESSAGES_DIR, "index.json");
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}

function genId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}_${rand}`;
}

// GET /api/tunnel/messages — list messages
tunnelRouter.get("/messages", async (req: Request, res: Response): Promise<void> => {
  const index = await loadIndex();
  let messages = index.messages;

  const agent = typeof req.query["agent"] === "string" ? req.query["agent"] : null;
  if (agent) {
    messages = messages.filter(
      (m) => m.from === agent || m.to === agent || m.to === "broadcast",
    );
  }

  const unread = req.query["unread"] === "true";
  if (unread) {
    messages = messages.filter((m) => !m.read);
  }

  res.json(messages.slice(-50));
});

// POST /api/tunnel/send — send a message
tunnelRouter.post("/send", async (req: Request, res: Response): Promise<void> => {
  const from = typeof req.body?.["from"] === "string" ? req.body["from"] : "";
  const to = typeof req.body?.["to"] === "string" ? req.body["to"] : "";
  const content = typeof req.body?.["content"] === "string" ? req.body["content"] : "";
  const type = typeof req.body?.["type"] === "string" ? req.body["type"] : "query";
  const metadata = (req.body?.["metadata"] as Record<string, unknown>) ?? {};

  if (!from || !to || !content) {
    res.status(400).json({ error: "from, to, and content required" });
    return;
  }

  const index = await loadIndex();
  index.lastId += 1;

  const message: TunnelMessage = {
    id: genId(),
    from,
    to,
    type: type as TunnelMessage["type"],
    content,
    metadata,
    timestamp: new Date().toISOString(),
    read: false,
  };

  index.messages.push(message);
  await saveIndex(index);

  // Also write a markdown file for Obsidian visibility
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const time = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const mdFile = path.join(
    MESSAGES_DIR,
    `${date}_tunnel_${from}_to_${to}_${time}.md`,
  );
  const md = `---
type: communication
from: ${from}
to: ${to}
timestamp: ${message.timestamp}
status: ${type}
---

# Tunnel Message: ${from} → ${to}

**From:** ${from}
**To:** ${to}
**Type:** ${type}
**Time:** ${message.timestamp}

---

${content}
`;
  await fs.writeFile(mdFile, md, "utf8");

  await audit("tunnel:send", `${from} → ${to}: ${content.slice(0, 100)}`);
  res.json(message);
});

// POST /api/tunnel/read/:id — mark as read
tunnelRouter.post("/read/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params["id"]);
  const index = await loadIndex();
  const msg = index.messages.find((m) => m.id === id);
  if (!msg) {
    res.status(404).json({ error: "not found" });
    return;
  }
  msg.read = true;
  await saveIndex(index);
  res.json({ ok: true });
});

// GET /api/tunnel/agents — list known agents
tunnelRouter.get("/agents", async (_req: Request, res: Response): Promise<void> => {
  const index = await loadIndex();
  res.json(index.agents);
});

// GET /api/tunnel/stream — SSE stream for real-time updates
tunnelRouter.get("/stream", async (req: Request, res: Response): Promise<void> => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const agent =
    typeof req.query["agent"] === "string" ? req.query["agent"] : null;

  let lastCount = 0;
  const index = await loadIndex();
  lastCount = index.messages.length;

  const interval = setInterval(async () => {
    try {
      const current = await loadIndex();
      if (current.messages.length > lastCount) {
        const newMessages = current.messages.slice(lastCount);
        for (const msg of newMessages) {
          if (agent && msg.from !== agent && msg.to !== agent && msg.to !== "broadcast") {
            continue;
          }
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }
        lastCount = current.messages.length;
      }
    } catch {
      // ignore read errors
    }
  }, 2000);

  req.on("close", () => {
    clearInterval(interval);
  });
});
