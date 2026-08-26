import { Router, type Request, type Response } from "express";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import { env } from "../lib/env";
import {
  dockerAvailable,
  dockerRestart,
  dockerStart,
  dockerStop,
  listContainers,
} from "../services/docker-service";

export const dockerRouter = Router();
export const artifactsRouter = Router();
export const auditRouter = Router();

dockerRouter.get("/status", async (_req, res): Promise<void> => {
  res.json({ available: await dockerAvailable() });
});

dockerRouter.get("/containers", async (_req, res): Promise<void> => {
  try {
    res.json(await listContainers());
  } catch (error: unknown) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

async function containerAction(
  req: Request,
  res: Response,
  action: (id: string) => Promise<string>,
): Promise<void> {
  const id = String(req.params["id"] ?? "");
  if (!/^[\w.-]+$/.test(id)) {
    res.status(400).json({ error: "invalid container id" });
    return;
  }
  try {
    await audit(`docker:${id}`, id);
    res.json({ result: await action(id) });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

dockerRouter.post("/containers/:id/start", (req, res) => void containerAction(req, res, dockerStart));
dockerRouter.post("/containers/:id/stop", (req, res) => void containerAction(req, res, dockerStop));
dockerRouter.post(
  "/containers/:id/restart",
  (req, res) => void containerAction(req, res, dockerRestart),
);

artifactsRouter.get("/", async (_req, res): Promise<void> => {
  const rows = await prisma.artifact.findMany({ orderBy: { id: "desc" }, take: 100 });
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

artifactsRouter.get("/:id/raw", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const artifact = await prisma.artifact.findUnique({ where: { id } }).catch(() => null);
  if (!artifact) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (artifact.contentBase64 !== null) {
    res.setHeader("Content-Type", artifact.mime);
    res.send(Buffer.from(artifact.contentBase64, "base64"));
    return;
  }
  res.type("text/plain").send(artifact.textPreview ?? "");
});

export const execRouter = Router();

execRouter.post("/", async (req, res): Promise<void> => {
  const command = typeof req.body?.["command"] === "string" ? req.body["command"] : "";
  const confirmed = req.body?.["confirmed"] === true;
  if (!command || !confirmed) {
    res.status(400).json({ error: "command and confirmed=true required" });
    return;
  }
  if (
    /\b(rm\s+-rf\s+[/~]|mkfs|dd\s+if=|:\(\)\s*\{)/.test(command) ||
    /\b(Remove-Item\s+.*-Recurse|Format-Volume|diskpart)\b/i.test(command)
  ) {
    await audit("exec:blocked", command);
    res.status(403).json({ error: "destructive pattern blocked" });
    return;
  }
  await audit("exec", command);
  const { spawn } = await import("node:child_process");
  const isWindows = process.platform === "win32";
  const child = isWindows
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: env.workspaceDir,
        timeout: 30_000,
      })
    : spawn("bash", ["-lc", command], { cwd: env.workspaceDir, timeout: 30_000 });
  let out = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { out += c.toString(); });
  child.on("error", (error: Error) => res.json({ output: `ERROR ${error.message}`, code: -1 }));
  child.on("close", (code: number | null) => res.json({ output: out.slice(0, 20000), code }));
});

auditRouter.get("/", async (_req, res): Promise<void> => {
  const rows = await prisma.auditLog.findMany({ orderBy: { id: "desc" }, take: 100 });
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
});
