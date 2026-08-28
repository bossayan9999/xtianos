import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import { encryptSecret, decryptSecret } from "../lib/env";

export const agentsRouter = Router();

// ── List agents ───────────────────────────────────────────────────────────────

agentsRouter.get("/", async (_req, res): Promise<void> => {
  const agents = await prisma.agent.findMany({ orderBy: { isGeneral: "desc" } });
  res.json(
    agents.map((a) => ({
      ...a,
      hasKey: Boolean(a.apiKeyEnc),
      apiKeyEnc: undefined,
    })),
  );
});

// ── Get one agent ─────────────────────────────────────────────────────────────

agentsRouter.get("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json({ ...agent, hasKey: Boolean(agent.apiKeyEnc), apiKeyEnc: undefined });
});

// ── Create agent ──────────────────────────────────────────────────────────────

agentsRouter.post("/", async (req, res): Promise<void> => {
  const { name, displayName, description, personality, systemPromptAdd, toolsAllowed, providerId, model, color, icon } =
    req.body ?? {};

  if (typeof name !== "string" || typeof displayName !== "string") {
    res.status(400).json({ error: "name and displayName required" });
    return;
  }

  const agent = await prisma.agent.create({
    data: {
      name,
      displayName,
      description: typeof description === "string" ? description : "",
      personality: typeof personality === "string" ? personality : "",
      systemPromptAdd: typeof systemPromptAdd === "string" ? systemPromptAdd : "",
      toolsAllowed: typeof toolsAllowed === "string" ? toolsAllowed : "*",
      providerId: typeof providerId === "number" ? providerId : null,
      model: typeof model === "string" ? model : null,
      color: typeof color === "string" ? color : "#57d9a3",
      icon: typeof icon === "string" ? icon : "🤖",
    },
  });

  await audit("agent:create", `${agent.name} (${agent.displayName})`);
  res.json(agent);
});

// ── Update agent ──────────────────────────────────────────────────────────────

agentsRouter.patch("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await prisma.agent.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const data: Record<string, unknown> = {};
  const fields = [
    "displayName", "description", "personality", "systemPromptAdd",
    "toolsAllowed", "model", "color", "icon", "orbitRadius", "orbitAngle",
    "status", "enabled",
  ];
  for (const field of fields) {
    if (field in (req.body ?? {})) {
      data[field] = req.body[field];
    }
  }
  if ("providerId" in (req.body ?? {})) {
    data["providerId"] = typeof req.body["providerId"] === "number" ? req.body["providerId"] : null;
  }

  const updated = await prisma.agent.update({ where: { id }, data });
  await audit("agent:update", `${updated.name}: ${JSON.stringify(data).slice(0, 200)}`);
  res.json({ ...updated, hasKey: Boolean(updated.apiKeyEnc), apiKeyEnc: undefined });
});

// ── Delete agent ──────────────────────────────────────────────────────────────

agentsRouter.delete("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const agent = await prisma.agent.findUnique({ where: { id } });
  if (agent?.isGeneral) {
    res.status(400).json({ error: "Cannot delete the general agent" });
    return;
  }

  await prisma.agent.delete({ where: { id } }).catch(() => undefined);
  await audit("agent:delete", `agent ${id}`);
  res.json({ ok: true });
});

// ── Update API key ────────────────────────────────────────────────────────────

agentsRouter.put("/:id/key", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const apiKey = typeof req.body?.["apiKey"] === "string" ? req.body["apiKey"] : "";
  if (apiKey.length === 0) {
    res.status(400).json({ error: "apiKey required" });
    return;
  }

  const encrypted = encryptSecret(apiKey);
  await prisma.agent.update({ where: { id }, data: { apiKeyEnc: encrypted } });
  await audit("agent:key-update", `agent ${id}`);
  res.json({ ok: true, hasKey: true });
});

// ── Probe agent provider ──────────────────────────────────────────────────────

agentsRouter.post("/:id/probe", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const provider = agent.providerId
    ? await prisma.provider.findUnique({ where: { id: agent.providerId } })
    : await prisma.provider.findFirst({ orderBy: { id: "asc" } });

  if (!provider) {
    res.json({ ok: false, error: "No provider configured" });
    return;
  }

  const key = agent.apiKeyEnc
    ? decryptSecret(agent.apiKeyEnc)
    : provider.apiKeyEnc
      ? decryptSecret(provider.apiKeyEnc)
      : "";

  if (!key) {
    res.json({ ok: false, error: "No API key set (agent or provider)" });
    return;
  }

  // Quick test: fetch model list
  try {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    res.json({ ok: response.ok, status: response.status, baseUrl: provider.baseUrl });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
