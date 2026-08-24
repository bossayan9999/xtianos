import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseGitHubUrl } from "./github";

const run = promisify(execFile);

const MD_RE = /\.md$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".github", "dist", "build", "__pycache__"]);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 400_000;

function frontmatter(url: string, branch: string): string {
  return `---\ntype: source\nsource: github\nurl: ${url}\nbranch: ${branch}\ningested: ${new Date().toISOString()}\n---\n\n`;
}

function tarballUrl(ref: { owner: string; repo: string; branch: string }): string {
  return `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/refs/heads/${ref.branch}`;
}

/**
 * Downloads a GitHub repo tarball and copies every markdown file into the
 * vault under BRAIN/Sources/<owner>-<repo>/… so it becomes part of mjane's
 * brain (browsable + RAG-indexed). Returns the number of notes written.
 */
export async function ingestRepoToBrain(
  url: string,
  vaultPath: string,
): Promise<{ repo: string; notes: number; destRel: string }> {
  const ref = parseGitHubUrl(url);
  if (!ref) throw new Error("not a valid github.com repo URL");

  const tmp = await fs.mkdtemp(path.join("/tmp/opencode", "xos-ingest-"));
  try {
    const tarball = path.join(tmp, `${ref.repo}.tar.gz`);
    let res = await fetch(tarballUrl(ref), { signal: AbortSignal.timeout(90_000) });
    if (!res.ok && ref.branch !== "master") {
      ref.branch = "master";
      res = await fetch(tarballUrl(ref), { signal: AbortSignal.timeout(90_000) });
    }
    if (!res.ok && ref.branch !== "main") {
      ref.branch = "main";
      res = await fetch(tarballUrl(ref), { signal: AbortSignal.timeout(90_000) });
    }
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await fs.writeFile(tarball, Buffer.from(await res.arrayBuffer()));
    await run("tar", ["-xzf", tarball, "-C", tmp]);
    await fs.rm(tarball, { force: true });

    // extracted root is the single entry inside tmp
    const entries = await fs.readdir(tmp);
    const root = path.join(tmp, entries[0] ?? "");
    let startDir = root;
    if (ref.subdir) startDir = path.join(root, ref.subdir);

    const destRoot = path.join(vaultPath, "BRAIN", "Sources", `${ref.owner}-${ref.repo}`);
    const fm = frontmatter(url, ref.branch);

    let notes = 0;
    const queue: string[] = [startDir];
    while (queue.length > 0 && notes < MAX_FILES) {
      const dir = queue.shift() as string;
      let dirEntries;
      try {
        dirEntries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of dirEntries) {
        if (notes >= MAX_FILES) break;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
          continue;
        }
        if (!MD_RE.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > MAX_FILE_BYTES) continue;
        const rel = path.relative(startDir, full);
        const dest = path.join(destRoot, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const body = await fs.readFile(full, "utf8").catch(() => "");
        if (body.trim().length === 0) continue;
        await fs.writeFile(dest, `${fm}${body}`, "utf8");
        notes += 1;
      }
    }
    if (notes === 0) throw new Error("no markdown files found in repo");
    return { repo: `${ref.owner}/${ref.repo}`, notes, destRel: path.join("BRAIN", "Sources", `${ref.owner}-${ref.repo}`) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
