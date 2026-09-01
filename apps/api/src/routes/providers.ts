import { Router, type Request, type Response } from "express";

import { prisma } from "../lib/db";
import { encryptSecret, decryptSecret } from "../lib/env";
import { clearResolveCache } from "../services/agent-service";
import { starterCatalog, listModels } from "@xtiand/mjane-core";

export const providersRouter = Router();

providersRouter.get("/", async (_req, res): Promise<void> => {
  const rows = await prisma.provider.findMany({ orderBy: { id: "asc" } });
  res.json(
    rows.map((row) => ({
      id: row.id,
      label: row.label,
      kind: row.kind,
      baseUrl: row.baseUrl,
      hasKey: (row.apiKeyEnc ?? "").length > 0,
    })),
  );
});

providersRouter.post("/", async (req, res): Promise<void> => {
  const { label, kind, baseUrl, apiKey } = req.body as Record<string, unknown>;
  if (typeof label !== "string" || typeof baseUrl !== "string") {
    res.status(400).json({ error: "label and baseUrl required" });
    return;
  }
  const provider = await prisma.provider.create({
    data: {
      label,
      kind: kind === "anthropic" ? "anthropic" : "openai-compat",
      baseUrl,
      apiKeyEnc: typeof apiKey === "string" && apiKey.length > 0 ? encryptSecret(apiKey) : null,
    },
  });
  res.json({ id: provider.id });
  clearResolveCache();
});

providersRouter.patch("/:id/key", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  const apiKey = typeof req.body?.["apiKey"] === "string" ? req.body["apiKey"] : "";
  if (Number.isNaN(id) || apiKey.length === 0) {
    res.status(400).json({ error: "id and apiKey required" });
    return;
  }
  await prisma.provider.update({
    where: { id },
    data: { apiKeyEnc: encryptSecret(apiKey) },
  });
  res.json({ ok: true });
  clearResolveCache();
});

providersRouter.delete("/:id", async (req, res): Promise<void> => {
  const id = Number.parseInt(String(req.params["id"]), 10);
  await prisma.provider.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
  clearResolveCache();
});

/** Searchable model catalog: static starters + live /models per provider. */
providersRouter.get("/models/catalog", async (req, res): Promise<void> => {
  const query = typeof req.query["q"] === "string" ? req.query["q"].toLowerCase() : "";
  const rows = await prisma.provider.findMany();
  let models: { id: string; label: string; providerId: number | null; kind: string }[] =
    starterCatalog().map((m) => ({ ...m, kind: m.kind as string }));
  for (const row of rows) {
    const key = decryptSecret(row.apiKeyEnc);
    const live =
      row.kind === "anthropic"
        ? ["claude-sonnet-4-6", "claude-opus-4-1"].map((id) => ({
            id: `${row.id}:${id}`,
            label: `${row.label} · ${id}`,
            providerId: row.id,
            kind: row.kind,
          }))
        : (await listModels(row.baseUrl, key).catch(() => []) as string[]).map((id) => ({
            id: `${row.id}:${id}`,
            label: `${row.label} · ${id}`,
            providerId: row.id,
            kind: "openai-compat" as const,
          }));
    models = [...live, ...models];
  }
  const filtered = query
    ? models.filter(
        (m) => m.label.toLowerCase().includes(query) || m.id.toLowerCase().includes(query),
      )
    : models;
  const seen = new Set<string>();
  // When no query, prioritize static starter catalog (NVIDIA, OpenCode, etc.) before live provider models
  const deduped = filtered.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  if (!query) {
    const starters = starterCatalog().map((s) => s.id);
    const staticModels = deduped.filter((m) => starters.includes(m.id));
    const liveModels = deduped.filter((m) => !starters.includes(m.id));
    res.json([...staticModels, ...liveModels].slice(0, 80));
  } else {
    res.json(deduped.slice(0, 80));
  }
});

providersRouter.get("/default-model", async (_req: Request, res: Response): Promise<void> => {
  const row = await prisma.setting.findUnique({ where: { key: "defaultModel" } });
  res.json({ defaultModel: row?.value ?? null });
});

providersRouter.put("/default-model", async (req, res): Promise<void> => {
  const model = typeof req.body?.["model"] === "string" ? req.body["model"] : "";
  if (!model) {
    res.status(400).json({ error: "model required" });
    return;
  }
  await prisma.setting.upsert({
    where: { key: "defaultModel" },
    update: { value: model },
    create: { key: "defaultModel", value: model },
  });
  res.json({ ok: true });
  clearResolveCache();
});
