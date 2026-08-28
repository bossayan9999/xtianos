import { Router } from "express";

import { audit } from "../lib/auth";
import { prisma } from "../lib/db";
import { rateLimit } from "../lib/guard";
import {
  listHousekeepingJobs,
  restartHousekeeper,
  runHousekeepingJob,
  setSetting,
} from "../services/housekeeper";

export const housekeepingRouter = Router();

const HK_PREFIX = "housekeeping.";

housekeepingRouter.use(rateLimit(60_000, 20, "housekeeping"));

housekeepingRouter.get("/", async (_req, res): Promise<void> => {
  res.json({ jobs: await listHousekeepingJobs() });
});

housekeepingRouter.get("/status", async (_req, res): Promise<void> => {
  res.json({ jobs: await listHousekeepingJobs() });
});

housekeepingRouter.post("/run/:key", async (req, res): Promise<void> => {
  const key = String(req.params["key"] ?? "");
  const apply = req.query["apply"] === "1" || req.body?.["apply"] === true;
  const wait = req.query["wait"] === "1" || req.body?.["wait"] === true;
  const result = await runHousekeepingJob(key, { apply, wait });
  if (result.error) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

housekeepingRouter.get("/settings", async (_req, res): Promise<void> => {
  const rows = await prisma.setting.findMany({ orderBy: { key: "asc" } });
  res.json(rows.filter((r) => r.key.startsWith(HK_PREFIX)));
});

housekeepingRouter.put("/settings", async (req, res): Promise<void> => {
  const key = typeof req.body?.["key"] === "string" ? req.body["key"] : "";
  const value = typeof req.body?.["value"] === "string" ? req.body["value"] : null;
  if (!key.startsWith(HK_PREFIX) || value === null) {
    res.status(400).json({ error: "housekeeping.* key and string value required" });
    return;
  }
  await setSetting(key, value);
  await audit("housekeeping:settings", `${key}=${value.slice(0, 100)}`);
  await restartHousekeeper();
  res.json({ ok: true });
});