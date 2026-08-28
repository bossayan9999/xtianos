import { Router, type Request, type Response } from "express";

import { prisma } from "../lib/db";
import { audit, AuthedRequest, authorizeRequestAccess } from "../lib/auth";
import { env } from "../lib/env";
import {
  dockerAvailable,
  dockerRestart,
  dockerStart,
  dockerStop,
  listContainers,
} from "../services/docker-service";
import { loadImageConfig, saveImageConfig, generateImage, type ImageConfig } from "../services/image-service";

export const dockerRouter = Router();
export const artifactsRouter = Router();
export const auditRouter = Router();
export const imageConfigRouter = Router();

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
  const authed = req as AuthedRequest;
  if (!(await authorizeRequestAccess(authed))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
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
  if (command.length > 2000) {
    await audit("exec:blocked", "command too long");
    res.status(400).json({ error: "command exceeds 2000 characters" });
    return;
  }
  const blockedPatterns = [
    /\b(rm\s+-rf\s+[/~]|mkfs|dd\s+if=|:\(\)\s*\{)/,
    /\b(Remove-Item\s+.*-Recurse|Format-Volume|diskpart)\b/i,
    /-EncodedCommand/i,
    /\b(IEX|Invoke-Expression|Invoke-RestMethod|Invoke-WebRequest|Start-Process|curl|wget|irm|iwr)\b/i,
    /\b(net\s+user|net\s+localgroup|reg\s+add|sc\s+create|schtasks|shutdown|restart-computer)\b/i,
    /([\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff])/,
  ];
  if (blockedPatterns.some((p) => p.test(command))) {
    await audit("exec:blocked", command);
    res.status(403).json({ error: "blocked command pattern (see exec:blocked audit entry)" });
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

const MASK = (key: string): string =>
  key.length <= 8 ? (key ? "••••" : "") : `${key.slice(0, 4)}••••${key.slice(-4)}`;

/** GET /api/image-config — current image provider config (apiKey masked). */
imageConfigRouter.get("/", async (_req: Request, res: Response): Promise<void> => {
  const cfg = await loadImageConfig();
  res.json({ ...cfg, apiKey: MASK(cfg.apiKey), hasKey: Boolean(cfg.apiKey) });
});

/** PUT /api/image-config — save image provider config. apiKey may be full (replaces) or masked (keeps). */
imageConfigRouter.put("/", async (req: Request, res: Response): Promise<void> => {
  const incoming = (req.body ?? {}) as Partial<ImageConfig>;
  const current = await loadImageConfig();
  let apiKey = String(incoming.apiKey ?? "").trim();
  // Preserve the stored key when the client round-trips an unchanged/masked value
  // (masked literals like "sk-a••••WXYZ" must not be persisted as the real key).
  if (apiKey.includes("••") || apiKey === current.apiKey || (current.apiKey && apiKey === MASK(current.apiKey))) {
    apiKey = current.apiKey;
  }
  apiKey = apiKey.replace(/^Bearer\s+/i, "").trim();
  const cfg: ImageConfig = {
    provider: (["openai", "flux", "stable", "nvidia"].includes(incoming.provider as string)
      ? incoming.provider
      : current.provider) as ImageConfig["provider"],
    apiKey,
    model: String(incoming.model ?? current.model),
    baseUrl: String(incoming.baseUrl ?? current.baseUrl),
  };
  if (!cfg.apiKey) return void res.status(400).json({ error: "apiKey is required" });
  await saveImageConfig(cfg);
  await audit("config:image", `provider=${cfg.provider} model=${cfg.model}`);
  res.json({ ...cfg, apiKey: MASK(cfg.apiKey), hasKey: true });
});

/** POST /api/image-config/test — generate a tiny image to validate the configured key/backend. */
imageConfigRouter.post("/test", async (_req: Request, res: Response): Promise<void> => {
  try {
    const cfg = await loadImageConfig();
    const img = await generateImage(cfg, { prompt: "a single red circle on white background", size: "256x256", quality: "low", style: "vivid" });
    await audit("image:test", `provider=${cfg.provider} ok ${img.format}`);
    res.json({ ok: true, mime: img.mime, format: img.format, bytes: img.base64.length });
  } catch (error: unknown) {
    await audit("image:test", `failed ${error instanceof Error ? error.message : String(error)}`);
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

