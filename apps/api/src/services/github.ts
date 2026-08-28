import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
  subdir: string;
}

/** Accepts https://github.com/owner/repo[/tree/branch[/subdir]] */
export function parseGitHubUrl(url: string): RepoRef | null {
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\/tree\/([^/]+)((?:\/[\w.-]+)*))?\/?$/.exec(
      url,
    );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    branch: match[3] ?? "main",
    subdir: (match[4] ?? "").replace(/^\//, ""),
  };
}

/**
 * Downloads the repo tarball and copies every folder containing a SKILL.md
 * into <skillsRoot>. Returns the list of installed skill dir names.
 */
export async function installSkillsFromGitHub(
  url: string,
  skillsRoot: string,
): Promise<string[]> {
  const ref = parseGitHubUrl(url);
  if (!ref) throw new Error("not a valid github.com repo URL");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xos-skill-"));
  try {
    const tarball = path.join(tmp, `${ref.repo}.tar.gz`);
    const res = await fetch(
      `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/refs/heads/${ref.branch}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} (check branch "${ref.branch}")`);
    }
    await fs.writeFile(tarball, Buffer.from(await res.arrayBuffer()));
    await run("tar", ["-xzf", tarball, "-C", tmp]);
    await fs.rm(tarball, { force: true });

    const installed: string[] = [];
    await findAndInstall(tmp, ref.subdir, skillsRoot, installed);
    return installed;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findAndInstall(
  searchDir: string,
  subdir: string,
  skillsRoot: string,
  installed: string[],
): Promise<void> {
  if ((await fs.stat(path.join(searchDir, subdir)).catch(() => null)) === null && subdir !== "") {
    return;
  }
  const startDir = subdir === "" ? searchDir : path.join(searchDir, subdir);
  const entries = await fs.readdir(startDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(startDir, entry.name);
    const hasSkill = await fs
      .stat(path.join(dirPath, "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    if (hasSkill) {
      let destName = entry.name;
      while (
        await fs
          .stat(path.join(skillsRoot, destName))
          .then(() => true)
          .catch(() => false)
      ) {
        destName = `${destName}-gh`;
      }
      await fs.cp(dirPath, path.join(skillsRoot, destName), { recursive: true });
      installed.push(destName);
    } else {
      await findAndInstall(dirPath, "", skillsRoot, installed);
    }
  }
}
