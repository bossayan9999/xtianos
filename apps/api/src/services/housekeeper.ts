import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { audit } from "../lib/auth";
import { env } from "../lib/env";
import { prisma } from "../lib/db";
import { reindexVault } from "./memory";
import { ingestRepoToBrain } from "./ingest";
import { delegateToAgent } from "./orchestrator";

// ── Settings keys ─────────────────────────────────────────────────────────────

const SK = {
  master: "housekeeping.enabled",
  cleanerEnable: "housekeeping.cleaner.enabled",
  cleanerInterval: "housekeeping.cleaner.intervalMs",
  cleanerRetention: "housekeeping.cleaner.retentionDays",
  cleanerApply: "housekeeping.cleaner.apply",
  organizerEnable: "housekeeping.organizer.enabled",
  organizerInterval: "housekeeping.organizer.intervalMs",
  organizerApply: "housekeeping.organizer.apply",
  autofixEnable: "housekeeping.autofix.enabled",
  autofixInterval: "housekeeping.autofix.intervalMs",
  autofixApply: "housekeeping.autofix.apply",
  autofixRepos: "housekeeping.autofix.repos",
  autofixScrape: "housekeeping.autofix.scrape",
} as const;

function lastKey(jobKey: string): string {
  return `housekeeping.last.${jobKey}`;
}

// ── Small setting helpers ─────────────────────────────────────────────────────

export async function getSetting(key: string, fallback: string): Promise<string> {
  return (await prisma.setting.findUnique({ where: { key } }))?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export function settingBool(v: string, fallback: boolean): boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

export function settingInt(v: string, fallback: number): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── Report types ──────────────────────────────────────────────────────────────

export interface JobReport {
  ok: boolean;
  summary: string;
  applied: boolean;
  items: Array<Record<string, unknown>>;
  errors: string[];
}

export interface JobStatus {
  key: string;
  label: string;
  enabled: boolean;
  intervalMs: number;
  apply: boolean;
  running: boolean;
  lastRun: string | null;
  lastOk: boolean | null;
  lastSummary: string | null;
}

// ── Cleaner ───────────────────────────────────────────────────────────────────

async function runCleaner(apply: boolean): Promise<JobReport> {
  const errors: string[] = [];
  const items: Array<Record<string, unknown>> = [];
  const retentionDays = settingInt(await getSetting(SK.cleanerRetention, "30"), 30);
  const cutoff = Date.now() - retentionDays * 86_400_000;

  // Which artifacts are actually referenced by a message ("ARTIFACT:<id>").
  const messages = await prisma.message.findMany({ select: { content: true } });
  const referenced = new Set<number>();
  for (const m of messages) {
    for (const r of m.content.matchAll(/ARTIFACT:(\d+)/g)) {
      referenced.add(Number.parseInt(r[1], 10));
    }
  }

  const artifacts = await prisma.artifact.findMany({ orderBy: { id: "asc" } });
  const hashGroups = new Map<string, number[]>();
  const deleteIds = new Set<number>();

  for (const a of artifacts) {
    const orphan = !referenced.has(a.id);
    const aged = retentionDays === 0 || a.createdAt.getTime() < cutoff;
    if (orphan && aged) {
      deleteIds.add(a.id);
      items.push({
        action: "artifact",
        kind: "orphan",
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        bytes: a.contentBase64 ? Math.round(a.contentBase64.length * 0.75) : (a.textPreview?.length ?? 0),
      });
    }
    if (a.contentBase64) {
      const h = crypto.createHash("sha256").update(a.contentBase64).digest("hex");
      const list = hashGroups.get(h) ?? [];
      list.push(a.id);
      hashGroups.set(h, list);
    }
  }

  // Duplicates: identical base64 content, where *every* copy is unreferenced.
  for (const ids of hashGroups.values()) {
    if (ids.length < 2) continue;
    const orphansOnly = ids.every((id) => !referenced.has(id));
    if (!orphansOnly) continue;
    const keepNewest = Math.max(...ids);
    for (const id of ids) {
      if (id === keepNewest) continue;
      const art = artifacts.find((a) => a.id === id);
      deleteIds.add(id);
      items.push({
        action: "artifact",
        kind: "duplicate",
        id,
        filename: art?.filename,
        dedupeOf: keepNewest,
      });
    }
  }

  // Workspace files orphaned from the DB (mcp images are stored as <id>_<name>).
  const idsInDb = new Set<number>();
  for (const a of artifacts) idsInDb.add(a.id);
  const workspaceEntries = await fs.readdir(env.workspaceDir).catch(() => []);
  const deleteFiles: string[] = [];
  let orphanBytes = 0;
  for (const entry of workspaceEntries) {
    const m = /^(\d+)_\S+\.(png|jpe?g|webp|gif|svg|bmp)$/i.exec(entry);
    if (m && !idsInDb.has(Number.parseInt(m[1], 10))) {
      const stat = await fs.stat(path.join(env.workspaceDir, entry)).catch(() => null);
      orphanBytes += stat?.size ?? 0;
      items.push({
        action: "file",
        kind: "orphan-workspace",
        path: entry,
        bytes: stat?.size ?? 0,
      });
      deleteFiles.push(entry);
    } else if (/^(Thumbs\.db|\.DS_Store|desktop\.ini)$/i.test(entry)) {
      const stat = await fs.stat(path.join(env.workspaceDir, entry)).catch(() => null);
      items.push({ action: "file", kind: "junk", path: entry, bytes: stat?.size ?? 0 });
      deleteFiles.push(entry);
    }
  }

  if (apply) {
    for (const id of deleteIds) {
      const art = artifacts.find((a) => a.id === id);
      await prisma.artifact.delete({ where: { id } }).catch(() => undefined);
      if (art) {
        await fs.rm(path.join(env.workspaceDir, `${id}_${art.filename}`), { force: true }).catch(() => undefined);
      }
    }
    for (const file of deleteFiles) {
      await fs.rm(path.join(env.workspaceDir, file), { force: true }).catch(() => undefined);
    }
  }

  const freed = deleteIds.size + deleteFiles.length;
  const summary =
    `${deleteIds.size} artifact(s) + ${deleteFiles.length} workspace file(s) ` +
    `(${orphanBytes > 0 ? `${Math.round(orphanBytes / 1024)} KB workspace` : "0 KB workspace"}) ` +
    `${apply ? "removed" : "found (dry-run)"}. retentionDays=${retentionDays}, referenced=${referenced.size}`;

  await audit("housekeeping:cleaner", `${apply ? "applied" : "dry-run"} · ${summary}`);
  return { ok: errors.length === 0, summary, applied: apply, items, errors };
}

// ── Organizer ─────────────────────────────────────────────────────────────────

/**
 * Classify a vault-relative path into a canonical BRAIN subfolder.
 * Pure — unit-tested.
 */
export function classifyBrainPath(rel: string, content: string): {
  to: string;
  reason: string;
  keep: boolean;
} {
  const relPosix = rel.replace(/\\/g, "/");
  const base = path.posix.basename(relPosix);
  const lower = `${relPosix} ${base}\n${content.slice(0, 500)}`.toLowerCase();

  if (/^BRAIN\//.test(relPosix)) return { to: "", reason: "already organized", keep: true };
  if (base.startsWith(".")) return { to: "", reason: "hidden file", keep: true };
  if (base === "Welcome.md") return { to: "", reason: "vault home note", keep: true };

  if (/^\d{4}[-/.]\d{1,2}/.test(base)) {
    return { to: "BRAIN/Sessions", reason: "date-prefixed session note", keep: false };
  }
  if (/(homeassistant|homelab|proxmox|pve|opnsense|pfsense|wireguard|tailscale|vlan|nginx|unraid|router|firewall)/.test(lower)) {
    return { to: "BRAIN/Homelab", reason: "homelab / infrastructure topic", keep: false };
  }
  if (/(mcp|skill|plugin|milestone|integration|scraper|scrape|service|tool|agent|workflow|github)/.test(lower)) {
    return { to: "BRAIN/Sources", reason: "tools / services / code sources", keep: false };
  }
  if (/(person|profile|interview|biograph|resume)/.test(lower)) {
    return { to: "BRAIN/Wiki/People", reason: "people / profile note", keep: false };
  }
  return { to: "BRAIN/Memory", reason: "uncategorized note", keep: false };
}

const CANONCIAL_FOLDERS = [
  "BRAIN/Sessions",
  "BRAIN/Projects",
  "BRAIN/Sources",
  "BRAIN/Wiki/People",
  "BRAIN/Memory",
  "BRAIN/Homelab",
];

async function uniqueDest(to: string, fromBase: string): Promise<string> {
  const ext = path.extname(fromBase);
  const stem = path.basename(fromBase, ext);
  let candidate = path.join(env.vaultPath, to, fromBase);
  let n = 2;
  while (await fs.stat(candidate).catch(() => null)) {
    candidate = path.join(env.vaultPath, to, `${stem} (${n++})${ext}`);
  }
  return candidate;
}

async function runOrganizer(apply: boolean): Promise<JobReport> {
  const items: Array<Record<string, unknown>> = [];
  const errors: string[] = [];

  // Ensure canonical folders exist (applies regardless of dry-run; mkdir is idempotent + harmless).
  for (const folder of CANONCIAL_FOLDERS) {
    await fs.mkdir(path.join(env.vaultPath, folder), { recursive: true });
  }
  items.push({ action: "folder", detail: `${CANONCIAL_FOLDERS.length} canonical BRAIN folders ensured` });

  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  }
  await walk(env.vaultPath);

  const proposals: Array<{ from: string; to: string; reason: string }> = [];
  for (const file of files) {
    const rel = path.relative(env.vaultPath, file).replace(/\\/g, "/");
    const content = await fs.readFile(file, "utf8").catch(() => "");
    const classified = classifyBrainPath(rel, content);
    if (classified.keep) continue;
    proposals.push({ from: rel, to: `${classified.to}/${path.posix.basename(rel)}`, reason: classified.reason });
    items.push({ action: "proposal", from: rel, to: proposals[proposals.length - 1].to, reason: classified.reason });
  }

  let moved = 0;
  if (apply) {
    for (const p of proposals) {
      const src = path.join(env.vaultPath, p.from);
      try {
        const dst = await uniqueDest(p.to, path.posix.basename(p.from));
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.rename(src, dst);
        moved += 1;
        await audit("housekeeping:organizer:move", `${p.from} -> ${path.relative(env.vaultPath, dst)}`);
      } catch (error: unknown) {
        errors.push(`${p.from}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await reindexVault(env.vaultPath).catch(() => undefined);
  }

  const summary = `${proposals.length} note(s) found to file (${moved} moved${apply ? "" : " — dry-run, apply off"})`;
  await audit("housekeeping:organizer", `${apply ? "applied" : "dry-run"} · ${summary}`);
  return { ok: errors.length === 0, summary, applied: apply, items, errors };
}

// ── Autofix (scrape + test + delegate fixes) ──────────────────────────────────

export function detectRepoInfo(repo: string): { testCmd: string } | null {
  try {
    if (existsSync(path.join(repo, "package.json"))) {
      return { testCmd: "npm test" };
    }
    if (["pytest.ini", "pyproject.toml", "requirements.txt", "setup.py"].some((f) => existsSync(path.join(repo, f)))) {
      return { testCmd: "python -m pytest -q" };
    }
    if (existsSync(path.join(repo, "go.mod"))) {
      return { testCmd: "go test ./..." };
    }
  } catch {
    return null;
  }
  return null;
}

function runShell(cmd: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const [prog, args] = isWin
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd]]
      : ["bash", ["-lc", cmd]];
    const child = spawn(prog, args, { cwd, timeout: 180_000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    child.on("error", (e: Error) => resolve({ code: -1, output: `spawn error: ${e.message}\n${out}${err}` }));
    child.on("close", (code: number | null) => resolve({ code, output: `${out}${err}`.slice(0, 8000) }));
  });
}

const clip = (s: string, n = 3000): string => (s.length <= n ? s : `${s.slice(0, n)}\n…[truncated]`);

async function runAutofix(apply: boolean): Promise<JobReport> {
  const errors: string[] = [];
  const items: Array<Record<string, unknown>> = [];
  const repos = (await getSetting(SK.autofixRepos, "")).split(",").map((s) => s.trim()).filter(Boolean);
  const scrape = (await getSetting(SK.autofixScrape, "")).split(",").map((s) => s.trim()).filter(Boolean);

  for (const url of scrape) {
    if (!/^https:\/\/github\.com\//.test(url)) {
      errors.push(`scrape: not a github URL: ${url}`);
      continue;
    }
    try {
      items.push({ action: "scrape", url, result: `incoming` });
      const result = await ingestRepoToBrain(url, env.vaultPath);
      items[items.length - 1] = { action: "scrape", url, notes: result.notes, repo: result.repo };
    } catch (error: unknown) {
      errors.push(`scrape ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (scrape.length > 0) await reindexVault(env.vaultPath).catch(() => undefined);

  if (repos.length === 0 && scrape.length === 0) {
    items.push({ action: "note", detail: "nothing configured — set housekeeping.autofix.repos (comma-separated repo paths) and/or .scrape (github URLs)" });
    return { ok: true, summary: "no repos or URLs configured — nothing to do", applied: apply, items, errors };
  }

  // Persistent conversation used as the thread for delegated fix work.
  let conv = await prisma.conversation.findFirst({ where: { title: "housekeeping" } });
  if (!conv) conv = await prisma.conversation.create({ data: { title: "housekeeping" } });
  const coder = await prisma.agent.findFirst({ where: { name: "coder", enabled: true } });

  for (const repo of repos) {
    const info = detectRepoInfo(repo);
    if (!info) {
      items.push({ action: "test", repo, result: "skip", reason: "no supported test runner detected" });
      continue;
    }
    let result = await runShell(info.testCmd, repo);
    items.push({
      action: "test", repo, cmd: info.testCmd, code: result.code,
      outcome: result.code === 0 ? "pass" : "fail",
      snippet: clip(result.output, 400),
    });

    let attempts = 0;
    while (result.code !== 0 && attempts < 2 && coder && apply) {
      attempts += 1;
      const task =
        `Investigate the failing automated tests in the repo at "${repo}". ` +
        `Test command: "${info.testCmd}" (run from the repo root). Failure output:\n\n${clip(result.output, 3000)}\n\n` +
        `Find the underlying bug(s), fix them, run "${info.testCmd}" again to confirm, then report what was wrong and how you fixed it.`;
      try {
        await delegateToAgent(coder.id, task, `Repo root: ${repo}`, conv.id, () => undefined);
      } catch (error: unknown) {
        errors.push(`autofix delegate (${repo}): ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      result = await runShell(info.testCmd, repo);
      items.push({
        action: "fix", repo, attempt: attempts, code: result.code,
        outcome: result.code === 0 ? "pass" : "still failing",
        snippet: clip(result.output, 400),
      });
    }
    if (result.code !== 0 && !apply) {
      items.push({ action: "note", repo, detail: "tests failing — dry-run (apply off), fix not delegated" });
    }
  }

  const summary = `${repos.length} repo(s) checked, ${scrape.length} URL(s) scraped, ${errors.length} error(s)`;
  await audit("housekeeping:autofix", `${apply ? "applied" : "dry-run"} · ${summary}`);
  return { ok: errors.length === 0, summary, applied: apply, items, errors };
}

// ── Registry + scheduler ──────────────────────────────────────────────────────

interface JobDef {
  key: string;
  label: string;
  enabledKey: string;
  intervalKey: string;
  applyKey: string;
  defaultIntervalMs: number;
  fn: (apply: boolean) => Promise<JobReport>;
}

const jobs: JobDef[] = [
  {
    key: "cleaner", label: "Clutter Cleaner",
    enabledKey: SK.cleanerEnable, intervalKey: SK.cleanerInterval, applyKey: SK.cleanerApply,
    defaultIntervalMs: 6 * 3600 * 1000, fn: runCleaner,
  },
  {
    key: "organizer", label: "Brain Organizer",
    enabledKey: SK.organizerEnable, intervalKey: SK.organizerInterval, applyKey: SK.organizerApply,
    defaultIntervalMs: 12 * 3600 * 1000, fn: runOrganizer,
  },
  {
    key: "autofix", label: "Auto Scrape + Bug Fixer",
    enabledKey: SK.autofixEnable, intervalKey: SK.autofixInterval, applyKey: SK.autofixApply,
    defaultIntervalMs: 24 * 3600 * 1000, fn: runAutofix,
  },
];

const timers = new Map<string, ReturnType<typeof setInterval>>();
const running = new Map<string, Promise<JobReport>>();

async function executeJob(job: JobDef, apply: boolean): Promise<JobReport> {
  const prev = running.get(job.key);
  if (prev) return prev; // already running — share the in-flight report

  const promise = (async (): Promise<JobReport> => {
    let report: JobReport;
    try {
      report = await job.fn(apply);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      report = { ok: false, summary: `job threw: ${message}`, applied: apply, items: [], errors: [message] };
    }
    await setSetting(lastKey(job.key), JSON.stringify({
      ts: Date.now(), ok: report.ok, summary: report.summary,
      applied: report.applied, items: report.items.length, errors: report.errors.length,
    }));
    await audit(`housekeeping:run:${job.key}`, `${report.applied ? "applied" : "dry-run"} · ${report.summary}`);
    return report;
  })();

  running.set(job.key, promise);
  try {
    return await promise;
  } finally {
    running.delete(job.key);
  }
}

/**
 * Kick a job now. async (fire-and-forget) unless wait=true.
 * Respects the global master switch unless force=true.
 */
export function runHousekeepingJob(
  key: string,
  opts?: { apply?: boolean; wait?: boolean; force?: boolean },
): Promise<{ started: boolean; apply: boolean; report?: JobReport; error?: string }> {
  return (async () => {
    const job = jobs.find((j) => j.key === key);
    if (!job) return { started: false, apply: false, error: `unknown job "${key}"` };
    if (!(await getSetting(SK.master, "true") !== "false") && !opts?.force) {
      return { started: false, apply: false, error: "housekeeping globally disabled (housekeeping.enabled)" };
    }
    const apply = opts?.apply ?? settingBool(await getSetting(job.applyKey, "false"), false);
    const promise = executeJob(job, apply);
    if (opts?.wait) {
      const report = await promise;
      return { started: true, apply, report };
    }
    return { started: true, apply };
  })();
}

function schedule(job: JobDef, intervalMs: number): void {
  const prev = timers.get(job.key);
  if (prev) clearInterval(prev);
  timers.set(
    job.key,
    setInterval(() => {
      void runHousekeepingJob(job.key).catch(() => undefined);
    }, intervalMs),
  );
}

/** (Re)read settings and (re)arm scheduler timers. idempotent. */
export async function restartHousekeeper(): Promise<void> {
  for (const job of jobs) {
    const enabled = settingBool(await getSetting(job.enabledKey, "true"), true);
    if (!enabled) {
      const prev = timers.get(job.key);
      if (prev) clearInterval(prev);
      timers.delete(job.key);
      continue;
    }
    const intervalMs = settingInt(await getSetting(job.intervalKey, String(job.defaultIntervalMs)), job.defaultIntervalMs);
    if (intervalMs > 0) schedule(job, intervalMs);
  }
}

export async function startHousekeeper(): Promise<void> {
  await audit("housekeeping:start", "housekeeper service started");
  await restartHousekeeper();
}

export async function stopHousekeeper(): Promise<void> {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
  await audit("housekeeping:stop", "housekeeper service stopped");
}

export async function listHousekeepingJobs(): Promise<JobStatus[]> {
  const out: JobStatus[] = [];
  for (const job of jobs) {
    const lastRaw = await getSetting(lastKey(job.key), "");
    let last: { ts?: number; ok?: boolean; summary?: string } | null = null;
    try {
      last = lastRaw ? (JSON.parse(lastRaw) as { ts?: number; ok?: boolean; summary?: string }) : null;
    } catch {
      last = null;
    }
    out.push({
      key: job.key,
      label: job.label,
      enabled: settingBool(await getSetting(job.enabledKey, "true"), true),
      intervalMs: settingInt(await getSetting(job.intervalKey, String(job.defaultIntervalMs)), job.defaultIntervalMs),
      apply: settingBool(await getSetting(job.applyKey, "false"), false),
      running: running.has(job.key),
      lastRun: last?.ts ? new Date(last.ts).toISOString() : null,
      lastOk: last?.ok ?? null,
      lastSummary: last?.summary ?? null,
    });
  }
  return out;
}