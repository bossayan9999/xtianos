import fs from "node:fs/promises";
import path from "node:path";

import type { ToolDef, ToolScope } from "../types";

function resolveInside(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root))) {
    throw new Error("path escapes sandbox root");
  }
  return target;
}

async function walkFiles(dir: string, base: string, out: string[], limit = 400): Promise<void> {
  if (out.length >= limit) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, base, out, limit);
    } else if (/\.(md|txt|json|ts|js|mjs|py|sh|ya?ml)$/i.test(entry.name)) {
      out.push(path.relative(base, full));
    }
  }
}

export function builtinTools(workspaceDir: string): ToolDef[] {
  const tools: ToolDef[] = [];

  const def = (
    name: string,
    description: string,
    scopes: ToolScope[],
    params: ToolDef["params"],
    run: ToolDef["run"],
  ): void => {
    tools.push({ name, description, scopes, params, run });
  };

  def(
    "brain_search",
    "Search the Obsidian vault (mjane's brain) for notes relevant to a query. Returns ranked paths + snippets.",
    ["read"],
    [{ name: "query", type: "string", description: "what to search for", required: true }],
    async (args, ctx) => {
      const query = String(args["query"] ?? "");
      const root = ctx.vaultPath || workspaceDir;
      const files: string[] = [];
      await walkFiles(root, root, files);
      const scored: { path: string; score: number; snippet: string }[] = [];
      for (const rel of files.slice(0, 300)) {
        const full = path.join(root, rel);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > 200_000) continue;
        const content = await fs.readFile(full, "utf8").catch(() => "");
        const lower = content.toLowerCase();
        let score = 0;
        for (const token of query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)) {
          if (lower.includes(token)) score += 1;
        }
        if (score > 0) {
          const idx = lower.indexOf(query.toLowerCase().split(/\s+/)[0] ?? "");
          const snippet = content
            .slice(Math.max(0, idx - 60), idx + 160)
            .replace(/\s+/g, " ")
            .trim();
          scored.push({ path: rel, score, snippet });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return JSON.stringify(scored.slice(0, 8), null, 2);
    },
  );

  def(
    "brain_read",
    "Read a note from the vault by relative path.",
    ["read"],
    [{ name: "path", type: "string", description: "relative path inside the vault", required: true }],
    async (args, ctx) => {
      const full = resolveInside(ctx.vaultPath || workspaceDir, String(args["path"]));
      return fs.readFile(full, "utf8");
    },
  );

  def(
    "brain_write",
    "Create or update a note in the vault. Parent folders are created automatically.",
    ["fs-write"],
    [
      { name: "path", type: "string", description: "relative path inside the vault", required: true },
      { name: "content", type: "string", description: "full markdown content to write", required: true },
    ],
    async (args, ctx) => {
      const full = resolveInside(ctx.vaultPath || workspaceDir, String(args["path"]));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, String(args["content"]), "utf8");
      ctx.emit({ type: "status", data: `wrote ${args["path"]}` });
      return `OK wrote ${String(args["path"]).length > 0 ? args["path"] : full}`;
    },
  );

  def(
    "workspace_write",
    "Write a file into the project artifacts workspace (code, docs, configs).",
    ["fs-write"],
    [
      { name: "filename", type: "string", description: "relative file path", required: true },
      { name: "content", type: "string", description: "file content as text", required: true },
    ],
    async (args, ctx) => {
      const full = resolveInside(ctx.workspaceDir, String(args["filename"]));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, String(args["content"]), "utf8");
      return `OK wrote ${String(args["filename"])}`;
    },
  );

  def(
    "web_search",
    "Research the web: search DuckDuckGo and return ranked results (title, url, snippet). Use before web_fetch to find sources.",
    ["net"],
    [
      { name: "query", type: "string", description: "search query", required: true },
      { name: "maxResults", type: "number", description: "how many results (default 6)", required: false },
    ],
    async (args) => {
      const query = String(args["query"] ?? "").slice(0, 400);
      const max = Math.min(Number(args["maxResults"] ?? 6) || 6, 10);
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
          headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) xtiandOS-mjane" },
        },
      );
      if (!res.ok) return `ERROR search failed: HTTP ${res.status}`;
      const html = await res.text();
      const results: { title: string; url: string; snippet: string }[] = [];
      const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const snippets: string[] = [];
      let sm: RegExpExecArray | null;
      while ((sm = snippetRe.exec(html)) !== null) {
        snippets.push(sm[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|'/g, "'").trim());
      }
      let lm: RegExpExecArray | null;
      while ((lm = linkRe.exec(html)) !== null && results.length < max) {
        let href = lm[1];
        const uddg = /uddg=([^&]+)/.exec(href);
        if (uddg) href = decodeURIComponent(uddg[1]);
        const title = lm[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
        if (title) {
          results.push({ title, url: href, snippet: snippets[results.length] ?? "" });
        }
      }
      if (results.length === 0) return "No results found.";
      return JSON.stringify(results, null, 2);
    },
  );

  def(
    "web_fetch",
    "Fetch a URL and return the response body as text (truncated to 8000 chars).",
    ["net"],
    [{ name: "url", type: "string", description: "http(s) URL to fetch", required: true }],
    async (args) => {
      const url = String(args["url"]);
      if (!/^https?:\/\//.test(url)) return "ERROR only http(s) URLs allowed";
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
      const contentType = res.headers.get("content-type") ?? "";
      let text = await res.text();
      if (contentType.includes("html") || /<html[\s>]/i.test(text.slice(0, 500))) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
          .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li)[^>]*>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#x27;|&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
      return `HTTP ${res.status} (${contentType})\n${text.slice(0, 6000)}`;
    },
  );

  def(
    "shell_exec",
    "Run a shell command on the host (sandbox profile: 30s timeout, output capped). Destructive commands require prior human approval in the UI.",
    ["exec"],
    [{ name: "command", type: "string", description: "shell command to run", required: true }],
    async (args, ctx) => {
      const command = String(args["command"]);
      const { spawn } = await import("node:child_process");
      return new Promise<string>((resolvePromise) => {
        const child = spawn("bash", ["-lc", command], { cwd: ctx.workspaceDir, timeout: 30_000 });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.on("error", (error: Error) => resolvePromise(`ERROR ${error.message}`));
        child.on("close", (code: number | null) =>
          resolvePromise(`exit=${code ?? "signal"}\n${out.slice(0, 8000)}`),
        );
      });
    },
  );

  return tools;
}
