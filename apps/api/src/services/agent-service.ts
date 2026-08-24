import fs from "node:fs/promises";
import path from "node:path";

import type { ChatMessage } from "@xtiand/shared";
import {
  ToolRegistry,
  builtinTools,
  loadSkillManifest,
  listSkillDirs,
  readSkillBody,
} from "@xtiand/mjane-core";
import { McpStdioClient } from "@xtiand/mcp-bridge";

import { prisma } from "../lib/db";
import { decryptSecret, env } from "../lib/env";
import { audit } from "../lib/auth";
import { searchMemory } from "./memory";
import { dashboardTools } from "./dashboard-tools";

export const skillsRoot = path.join(path.dirname(env.vaultPath), "skills-installed");

async function activeSkills(): Promise<{ name: string; body: string }[]> {
  const rows = await prisma.skill.findMany({ where: { enabled: true } });
  const out: { name: string; body: string }[] = [];
  for (const row of rows) {
    const body = await readSkillBody(skillsRoot, row.dirName).catch(() => null);
    if (body !== null) out.push({ name: row.name, body });
  }
  return out;
}

export async function buildRegistry(conversationId: number | null): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  for (const tool of builtinTools(env.workspaceDir)) {
    if (tool.scopes.includes("exec") || tool.scopes.includes("fs-write")) {
      const original = tool.run;
      tool.run = async (
        args: Record<string, unknown>,
        ctx: import("@xtiand/mjane-core").ToolContext,
      ) => {
        await audit(`tool:${tool.name}`, JSON.stringify(args).slice(0, 1500));
        return original(args, ctx);
      };
    }
    registry.register(tool);
  }

  for (const tool of dashboardTools()) {
    registry.register(tool);
  }

  registry.register({
    name: "memory_search",
    description: "Search mjane's long-term memory (vault index + past sessions) for relevant context.",
    scopes: ["read"],
    params: [{ name: "query", type: "string", description: "what to recall", required: true }],
    run: async (args: Record<string, unknown>) => {
      const hits = await searchMemory(String(args["query"] ?? ""), { limit: 6 });
      return JSON.stringify(hits, null, 2);
    },
  });

  registry.register({
    name: "task_create",
    description: "Create a task in a project workflow board.",
    scopes: [],
    params: [
      { name: "title", type: "string", description: "task title", required: true },
      { name: "projectName", type: "string", description: "project name; created if missing", required: false },
    ],
    run: async (args: Record<string, unknown>) => {
      const title = String(args["title"]);
      let projectId: number | null = null;
      const projectName = typeof args["projectName"] === "string" ? args["projectName"] : "";
      if (projectName.length > 0) {
        const project =
          (await prisma.project.findFirst({ where: { name: projectName } })) ??
          (await prisma.project.create({ data: { name: projectName } }));
        projectId = project.id;
      }
      const task = await prisma.task.create({ data: { title, projectId } });
      return `OK task #${task.id} "${task.title}"`;
    },
  });

  registry.register({
    name: "artifact_save",
    description:
      "Save generated content (text, code, base64 image/video data) into the artifacts library.",
    scopes: ["fs-write"],
    params: [
      { name: "filename", type: "string", description: "e.g. diagram.png or script.py", required: true },
      { name: "mime", type: "string", description: "MIME type", required: true },
      { name: "kind", type: "string", description: "one of text|code|image|video|other", required: true },
      { name: "contentBase64", type: "string", description: "base64 payload (binary) — omit for text content", required: false },
      { name: "textContent", type: "string", description: "plain text/code payload", required: false },
    ],
    run: async (args: Record<string, unknown>) => {
      const filename = String(args["filename"]).replace(/[/\\]/g, "_");
      const b64 = typeof args["contentBase64"] === "string" ? args["contentBase64"] : null;
      const text = typeof args["textContent"] === "string" ? args["textContent"] : null;
      if (b64 === null && text === null) return "ERROR provide contentBase64 or textContent";
      // renderable text formats (svg/html) are stored as base64 so /raw
      // serves them with their real mime type and browsers can display them
      const mime = String(args["mime"]);
      const renderableText = b64 === null && text !== null && /^(image\/|text\/html)/.test(mime);
      const artifact = await prisma.artifact.create({
        data: {
          conversationId,
          kind: String(args["kind"]),
          filename,
          mime,
          contentBase64:
            b64 ?? (renderableText ? Buffer.from(text as string, "utf8").toString("base64") : null),
          textPreview: text?.slice(0, 2000) ?? null,
        },
      });
      if (b64 !== null) {
        await fs.writeFile(
          path.join(env.workspaceDir, `${artifact.id}_${filename}`),
          Buffer.from(b64, "base64"),
        );
      }
      return `OK artifact #${artifact.id}`;
    },
  });

  return registry;
}

export interface ResolvedProvider {
  providerId: number;
  kind: "openai-compat" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function resolveProvider(modelSpec: string | null): Promise<ResolvedProvider> {
  const spec = modelSpec ?? (await prisma.setting.findUnique({ where: { key: "defaultModel" } }))?.value ?? null;
  let providerId: number;
  let model: string;
  if (spec !== null && /^\d+:/.test(spec)) {
    [providerId, model] = [Number.parseInt(spec.slice(0, spec.indexOf(":")), 10), spec.slice(spec.indexOf(":") + 1)];
  } else {
    const first = await prisma.provider.findFirst({ orderBy: { id: "asc" } });
    if (!first) throw new Error("no AI provider configured — add one in Settings");
    providerId = first.id;
    model = spec ?? first.label;
  }
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error("configured provider no longer exists");
  return {
    providerId,
    kind: provider.kind === "anthropic" ? "anthropic" : "openai-compat",
    baseUrl: provider.baseUrl,
    apiKey: decryptSecret(provider.apiKeyEnc),
    model,
  };
}

async function readBrainFile(rel: string): Promise<string | null> {
  return fs.readFile(path.join(env.vaultPath, rel), "utf8").catch(() => null);
}

async function listContextFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(env.vaultPath, "BRAIN", "context"), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => `BRAIN/context/${e.name}`);
  } catch {
    return [];
  }
}

const MODE_DIRECTIVES: Record<string, string> = {
  chat:
    "MODE chat — converse normally. Use tools when they genuinely help; keep answers tight.",
  plan:
    "MODE plan — research thoroughly first (memory_search, web_search/web_fetch, brain notes), then produce a structured step-by-step plan with phases, risks and success criteria. Save the final plan into the vault with brain_write under BRAIN/Projects/plans/<slug>.md. Do NOT execute anything.",
  build:
    "MODE build — execute the agreed plan: use workspace_write, shell_exec, task_create and other tools to actually implement. Verify your work before declaring done.",
};

const OUTPUT_DIRECTIVES: Record<string, string> = {
  text: "",
  image:
    'OUTPUT FORMAT image — reply with ONE self-contained static SVG (<svg xmlns="http://www.w3.org/2000/svg">) that visualizes the answer. Save it with artifact_save (filename ending .svg, mime image/svg+xml, kind image), then end your final message with a line exactly like ARTIFACT:<id> using the saved id, followed by a one-sentence summary. SVG text must be readable; dark background (#0f1420) with light strokes.',
  animation:
    'OUTPUT FORMAT animation — reply with ONE self-contained ANIMATED SVG (use <animate>/<animateTransform> SMIL elements, loop indefinitely). Save it with artifact_save (… .svg, image/svg+xml, kind video), then end your final message with a line exactly like ARTIFACT:<id>, followed by a one-sentence summary. Dark theme, smooth motion.',
  data:
    "OUTPUT FORMAT data — reply with structured data only: either a JSON object or a markdown table. No prose beyond one intro line.",
};

export async function buildSystemPrompt(
  conversationId: number,
  question = "",
  mode: "chat" | "plan" | "build" = "chat",
  output: "text" | "image" | "animation" | "data" = "text",
): Promise<string> {
  const parts: string[] = [
    "You are mjane, the copilot manager of xtiandOS — an agentic home-lab web OS on Kali Linux.",
    "Restate ambiguous goals in one line before acting. Prefer tools over guessing.",
    "When you use memory or brain notes, mention which note you recalled.",
    "Your long-term memory includes past conversations (paths like conversations/<id>) and wiki sources under BRAIN/Sources. When the user asks what you remember, what you did together, or about topics from earlier, ALWAYS use the memory_search tool — never claim you cannot recall.",
    "Ask exactly one clarifying question when requirements are unclear; otherwise act.",
  ];
  parts.push(MODE_DIRECTIVES[mode] ?? MODE_DIRECTIVES["chat"]);
  const outDirective = OUTPUT_DIRECTIVES[output];
  if (outDirective) parts.push(outDirective);
  const mojo = await readBrainFile("BRAIN/identity/mojo.md");
  if (mojo) parts.push(`### Your identity (always apply)\n${mojo.slice(0, 1800)}`);
  const contextFiles = await listContextFiles();
  for (const rel of contextFiles.slice(0, 10)) {
    const body = await readBrainFile(rel);
    if (body && !rel.endsWith("context-guide.md")) {
      parts.push(`### Context: ${rel}\n${body.slice(0, 2500)}`);
    }
  }
  if (conversationId >= 0) {
    const memoryQuery = question.trim().length > 0 ? question : "recent context decisions";
    const relevant = await searchMemory(memoryQuery, { limit: 5 });
    if (relevant.length > 0) {
      parts.push(
        `Potentially relevant memories (cite which you used):\n${relevant
          .map((hit) => `- [${hit.path ?? "memory"}] ${hit.content.slice(0, 200).replace(/\n/g, " ")}`)
          .join("\n")}`,
      );
    }
  }
  for (const skill of await activeSkills()) {
    parts.push(`### Skill: ${skill.name}\n${skill.body.slice(0, 2500)}`);
  }
  return parts.join("\n\n");
}

export async function loadHistory(conversationId: number): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { id: "asc" },
    take: 40,
  });
  return rows.map((row) => ({
    role: row.role as ChatMessage["role"],
    content: row.content,
    toolCalls:
      row.toolCallsJson !== null
        ? (JSON.parse(row.toolCallsJson) as ChatMessage["toolCalls"])
        : undefined,
  }));
}

export async function connectEnabledMcpServers(): Promise<McpStdioClient[]> {
  const clients: McpStdioClient[] = [];
  const servers = await prisma.mcpServer.findMany({ where: { enabled: true } }).catch(() => []);
  for (const server of servers) {
    const client = new McpStdioClient();
    try {
      await client.connect(server.command, server.args.split(/\s+/).filter(Boolean), server.envJson);
      clients.push(client);
    } catch {
      client.dispose();
    }
  }
  return clients;
}

export { env as agentEnv };

export async function ensureSkillsRoot(): Promise<void> {
  await fs.mkdir(skillsRoot, { recursive: true }).catch(() => undefined);
}
