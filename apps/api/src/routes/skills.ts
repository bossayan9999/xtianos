import { Router, type Request, type Response } from "express";

import { prisma } from "../lib/db";
import { audit } from "../lib/auth";
import { env } from "../lib/env";
import { skillsRoot } from "../services/agent-service";
import { installSkillsFromGitHub } from "../services/github";
import {
  loadSkillManifest,
  listSkillDirs,
  readSkillBody,
} from "@xtiand/mjane-core";

export const skillsRouter = Router();

async function scanSkills(): Promise<void> {
  const dirNames = await listSkillDirs(skillsRoot);
  for (const dirName of dirNames) {
    const manifest = await loadSkillManifest(skillsRoot, dirName);
    if (!manifest) continue;
    await prisma.skill.upsert({
      where: { dirName },
      update: { name: manifest.name, description: manifest.description },
      create: { dirName, name: manifest.name, description: manifest.description, source: "local" },
    });
  }
}

skillsRouter.get("/", async (_req, res): Promise<void> => {
  await scanSkills();
  const rows = await prisma.skill.findMany({ orderBy: { name: "asc" } });
  res.json(rows);
});

skillsRouter.get("/:dirName/body", async (req, res): Promise<void> => {
  const body = await readSkillBody(skillsRoot, String(req.params["dirName"]));
  if (body === null) {
    res.status(404).json({ error: "skill not found" });
    return;
  }
  res.json({ body });
});

skillsRouter.patch("/:dirName", async (req, res): Promise<void> => {
  const dirName = String(req.params["dirName"]);
  const enabled = req.body?.["enabled"];
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled boolean required" });
    return;
  }
  const skill = await prisma.skill.update({ where: { dirName }, data: { enabled } }).catch(() => null);
  if (!skill) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(skill);
});

skillsRouter.post("/install-github", async (req, res): Promise<void> => {
  const url = typeof req.body?.["url"] === "string" ? req.body["url"] : "";
  if (!url.startsWith("https://github.com/")) {
    res.status(400).json({ error: "github repo URL required" });
    return;
  }
  try {
    await audit("skills:install", url);
    const installed = await installSkillsFromGitHub(url, skillsRoot);
    await scanSkills();
    res.json({ installed });
  } catch (error: unknown) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
