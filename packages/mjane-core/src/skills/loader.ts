import fs from "node:fs/promises";
import path from "node:path";

import type { SkillManifest } from "@xtiand/shared";

/** Minimal frontmatter reader for SKILL.md files (key: value + "- item" lists). */
function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  const out: Record<string, string | string[]> = {};
  if (!match) return out;
  let currentKey = "";
  for (const line of match[1].split("\n")) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey.length > 0) {
      const existing = out[currentKey];
      if (Array.isArray(existing)) existing.push(listItem[1].trim());
      else out[currentKey] = [listItem[1].trim()];
      continue;
    }
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      const value = kv[2].trim();
      if (value.length > 0) out[currentKey] = value;
      else out[currentKey] = [];
    }
  }
  return out;
}

export async function loadSkillManifest(dir: string, dirName: string): Promise<SkillManifest | null> {
  const skillPath = path.join(dir, dirName, "SKILL.md");
  const raw = await fs.readFile(skillPath, "utf8").catch(() => null);
  if (raw === null) return null;
  const fm = parseFrontmatter(raw);
  const name = typeof fm["name"] === "string" ? fm["name"] : dirName;
  return {
    name,
    description: typeof fm["description"] === "string" ? fm["description"] : "",
    whenToUse: Array.isArray(fm["when-to-use"]) ? fm["when-to-use"] : [],
    allowedTools: Array.isArray(fm["allowed-tools"]) ? fm["allowed-tools"] : [],
    dirName,
    enabled: false,
    source: "local",
  };
}

export async function listSkillDirs(skillsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readSkillBody(skillsRoot: string, dirName: string): Promise<string | null> {
  return fs.readFile(path.join(skillsRoot, dirName, "SKILL.md"), "utf8").catch(() => null);
}
