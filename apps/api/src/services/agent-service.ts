import fs from "node:fs/promises";
import path from "node:path";

import type { ChatMessage } from "@xtiand/shared";
import {
  ToolRegistry,
  builtinTools,
  listModels,
  loadSkillManifest,
  listSkillDirs,
  readSkillBody,
} from "@xtiand/mjane-core";
import { createMcpClient, type McpClientLike, type McpServerSpec } from "@xtiand/mcp-bridge";

import { prisma } from "../lib/db";
import { decryptSecret, env } from "../lib/env";
import { audit } from "../lib/auth";
import { searchMemory } from "./memory";
import { dashboardTools } from "./dashboard-tools";
import { budgetTools } from "./budget-tools";
import { orchestrateTools } from "./orchestrator";
import { imageTool, imageReadTool } from "./image-tools";

export const skillsRoot = path.join(path.dirname(env.vaultPath), "skills-installed");

async function activeSkills(): Promise<{ name: string; body: string }[]> {
  const rows = await prisma.skill.findMany({ where: { enabled: true } });
  const out: { name: string; body: string }[] = [];
  for (const row of rows) {
    const body = await readSkillBody(skillsRoot, row.dirName).catch(() => null);
    if (body !== null) out.push({ name: row.name, body });
  }
  return out;
}

export async function buildRegistry(conversationId: number | null): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  for (const tool of builtinTools(env.workspaceDir)) {
    if (tool.scopes.includes("exec") || tool.scopes.includes("fs-write")) {
      const original = tool.run;
      tool.run = async (
        args: Record<string, unknown>,
        ctx: import("@xtiand/mjane-core").ToolContext,
      ) => {
        await audit(`tool:${tool.name}`, JSON.stringify(args).slice(0, 1500));
        return original(args, ctx);
      };
    }
    registry.register(tool);
  }

  for (const tool of dashboardTools()) {
    registry.register(tool);
  }

  // Budget system — read dashboard/transactions and (with approval) log entries.
  for (const tool of budgetTools()) {
    registry.register(tool);
  }

  registry.register({
    name: "memory_search",
    description: "Search mjane's long-term memory (vault index + past sessions) for relevant context.",
    scopes: ["read"],
    params: [{ name: "query", type: "string", description: "what to recall", required: true }],
    run: async (args: Record<string, unknown>) => {
      const hits = await searchMemory(String(args["query"] ?? ""), { limit: 6 });
      return JSON.stringify(hits, null, 2);
    },
  });

  registry.register({
    name: "task_create",
    description: "Create a task in a project workflow board.",
    scopes: [],
    params: [
      { name: "title", type: "string", description: "task title", required: true },
      { name: "projectName", type: "string", description: "project name; created if missing", required: false },
    ],
    run: async (args: Record<string, unknown>) => {
      const title = String(args["title"]);
      let projectId: number | null = null;
      const projectName = typeof args["projectName"] === "string" ? args["projectName"] : "";
      if (projectName.length > 0) {
        const project =
          (await prisma.project.findFirst({ where: { name: projectName } })) ??
          (await prisma.project.create({ data: { name: projectName } }));
        projectId = project.id;
      }
      const task = await prisma.task.create({ data: { title, projectId } });
      return `OK task #${task.id} "${task.title}"`;
    },
  });

  registry.register({
    name: "artifact_save",
    description:
      "Save generated content (text, code, base64 image/video data) into the artifacts library.",
    scopes: ["fs-write"],
    params: [
      { name: "filename", type: "string", description: "e.g. diagram.png or script.py", required: true },
      { name: "mime", type: "string", description: "MIME type", required: true },
      { name: "kind", type: "string", description: "one of text|code|image|video|other", required: true },
      { name: "contentBase64", type: "string", description: "base64 payload (binary) — omit for text content", required: false },
      { name: "textContent", type: "string", description: "plain text/code payload", required: false },
    ],
    run: async (
      args: Record<string, unknown>,
      ctx: import("@xtiand/mjane-core").ToolContext,
    ) => {
      const filename = String(args["filename"]).replace(/[/\\]/g, "_");
      const b64 = typeof args["contentBase64"] === "string" ? args["contentBase64"] : null;
      const text = typeof args["textContent"] === "string" ? args["textContent"] : null;
      if (b64 === null && text === null) return "ERROR provide contentBase64 or textContent";
      // renderable text formats (svg/html) are stored as base64 so /raw
      // serves them with their real mime type and browsers can display them
      const mime = String(args["mime"]);
      const renderableText = b64 === null && text !== null && /^(image\/|text\/html)/.test(mime);
      const artifact = await prisma.artifact.create({
        data: {
          conversationId,
          kind: String(args["kind"]),
          filename,
          mime,
          contentBase64:
            b64 ?? (renderableText ? Buffer.from(text as string, "utf8").toString("base64") : null),
          textPreview: text?.slice(0, 2000) ?? null,
        },
      });
      if (b64 !== null) {
        await fs.writeFile(
          path.join(env.workspaceDir, `${artifact.id}_${filename}`),
          Buffer.from(b64, "base64"),
        );
      }
      ctx.emit({
        type: "artifact",
        data: { id: artifact.id, filename, mime, kind: String(args["kind"]) },
      });
      return `OK artifact #${artifact.id}`;
    },
  });

  // Orchestration tools (mjane-as-general)
  for (const tool of orchestrateTools()) {
    registry.register(tool);
  }

  // Real image generation available to mjane too
  const imgTool = imageTool({ enabled: true });
  if (imgTool) registry.register(imgTool);

  // Let mjane view images too (vision read-back)
  registry.register(imageReadTool());

  return registry;
}

export interface ResolvedProvider {
  providerId: number;
  kind: "openai-compat" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}

// Short-TTL cache for provider resolution. resolveProvider can round-trip the
// DB (and hit listModels) on every message; for a stable model spec the result
// virtually never changes between requests, so memoize it briefly.
const resolveCache = new Map<string, { value: ResolvedProvider; expiresAt: number }>();
const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Invalidate the provider-resolution cache (call whenever providers/model change). */
export function clearResolveCache(): void {
  resolveCache.clear();
}

export async function resolveProvider(modelSpec: string | null): Promise<ResolvedProvider> {
  const rawSpec = modelSpec ?? (await prisma.setting.findUnique({ where: { key: "defaultModel" } }))?.value ?? null;
  const cacheKey = rawSpec ? String(rawSpec) : "__default__";
  const hit = resolveCache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  const spec = rawSpec;
  const resolve = async (providerId: number, model: string): Promise<ResolvedProvider> => {
    const provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new Error("configured provider no longer exists");
    return {
      providerId,
      kind: provider.kind === "anthropic" ? "anthropic" : "openai-compat",
      baseUrl: provider.baseUrl,
      apiKey: decryptSecret(provider.apiKeyEnc),
      model,
    };
  };

  let result: ResolvedProvider;

  // Provider-qualified spec (e.g. "2:claude-sonnet-4-6") -> use that provider.
  if (spec !== null && /^\d+:/.test(spec)) {
    const [providerId, model] = [
      Number.parseInt(spec.slice(0, spec.indexOf(":")), 10),
      spec.slice(spec.indexOf(":") + 1),
    ];
    result = await resolve(providerId, model);
  } else if (spec !== null) {
    // Unqualified spec (e.g. a starter-catalog OpenCode model like
    // "nemotron-3-ultra-free"). Route it to a configured provider that hosts
    // that model and has a key; otherwise fall back to the first provider.
    // Without this, picking a free OpenCode model would silently hit the
    // first (possibly keyless) provider -> 401.
    const providers = await prisma.provider.findMany({ orderBy: { id: "asc" } });
    let matched: ResolvedProvider | null = null;
    for (const p of providers) {
      if ((p.apiKeyEnc ?? "").length === 0) continue;
      const key = decryptSecret(p.apiKeyEnc);
      const live = await listModels(p.baseUrl, key).catch(() => [] as string[]);
      if (live.includes(spec)) {
        matched = await resolve(p.id, spec);
        break;
      }
    }
    if (matched) {
      result = matched;
    } else {
      const first = await prisma.provider.findFirst({ orderBy: { id: "asc" } });
      if (!first) throw new Error("no AI provider configured — add one in Settings");
      result = await resolve(first.id, spec ?? first.label);
    }
  } else {
    const first = await prisma.provider.findFirst({ orderBy: { id: "asc" } });
    if (!first) throw new Error("no AI provider configured — add one in Settings");
    result = await resolve(first.id, spec ?? first.label);
  }

  // Clear the cache when the underlying data changes.
  resolveCache.set(cacheKey, { value: result, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
  return result;
}

async function readBrainFile(rel: string): Promise<string | null> {
  return fs.readFile(path.join(env.vaultPath, rel), "utf8").catch(() => null);
}

async function listContextFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(env.vaultPath, "BRAIN", "context"), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => `BRAIN/context/${e.name}`);
  } catch {
    return [];
  }
}

const MODE_DIRECTIVES: Record<string, string> = {
  chat:
    "MODE chat — converse normally. Use tools when they genuinely help; keep answers tight.",
  plan:
    "MODE plan — research thoroughly first (memory_search, web_search/web_fetch, brain notes), then produce a structured step-by-step plan with phases, risks and success criteria. Save the final plan into the vault with brain_write under BRAIN/Projects/plans/<slug>.md. Do NOT execute anything.",
  build:
    "MODE build — execute the agreed plan: use workspace_write, shell_exec, task_create and other tools to actually implement. Verify your work before declaring done.",
};

export type ChatStyle = "speed" | "balanced" | "structured" | "deep";

export function isChatStyle(value: unknown): value is ChatStyle {
  return value === "speed" || value === "balanced" || value === "structured" || value === "deep";
}

const STYLE_DIRECTIVES: Record<ChatStyle, string> = {
  balanced:
    "STYLE balanced — be concise and direct: lead with the answer in 1-3 tight sentences, then add only the detail that genuinely helps. No rambling, no boilerplate, no restating the question.",
  speed:
    "STYLE speed — zero-shot, get to the point, high signal. Reply in at most 1-3 short plain sentences with no preamble, no markdown headings, no numbered lists, no bullets, no bold lead-in, and no 'takeaway' line. Give the first correct answer directly; skip elaborating unless explicitly asked.",
  structured:
    "STYLE structured — few-shot formatting. Always answer with a consistent, scannable structure: one one-sentence intro (the takeaway), then clear sections (## headings) or a bullet list / table where it fits, ending with a one-line 'Next step' or action. Mirror any structure the user's message implies (numbers, columns, steps), and keep the same shape for repeated questions.",
  deep:
    "STYLE deep — chain-of-thought reasoning. Break the problem into explicit steps, reason carefully and show the trail of reasoning: enumerate options, weigh pros/cons, then conclude with a recommended answer and a quick sanity-check/verification. Take the time to be thorough and precise; it's fine to be longer.",
};

const OUTPUT_DIRECTIVES: Record<string, string> = {
  text: "",
  image:
    'OUTPUT FORMAT image — produce ONE visual. For a photorealistic image, prefer an image-generation MCP tool when one is available (a tool whose name starts with mcp_ and describes image generation, e.g. mcp_generate_image). Call it with a descriptive prompt; the tool saves the image itself and its result will already include the artifact id (ARTIFACT:<id>) — do NOT re-save it. If no such MCP tool exists, you may use image_generate instead. If the chosen tool errors or is unavailable, DO NOT leave the user without an image — immediately fall back to a self-contained SVG (<svg xmlns="http://www.w3.org/2000/svg">) saved with artifact_save (filename ending .svg, mime image/svg+xml, kind image). Always end your final message with a line exactly like ARTIFACT:<id> using the saved id, followed by a one-sentence summary. For SVG: text must be readable; dark background (#0f1420) with light strokes.',
  animation:
    'OUTPUT FORMAT animation — reply with ONE self-contained ANIMATED SVG (use <animate>/<animateTransform> SMIL elements, loop indefinitely). Save it with artifact_save (… .svg, image/svg+xml, kind video), then end your final message with a line exactly like ARTIFACT:<id>, followed by a one-sentence summary. Dark theme, smooth motion.',
  data:
    "OUTPUT FORMAT data — reply with structured data only: either a JSON object or a markdown table. No prose beyond one intro line.",
};

export async function buildSystemPrompt(
  conversationId: number,
  question = "",
  mode: "chat" | "plan" | "build" = "chat",
  output: "text" | "image" | "animation" | "data" = "text",
  mcpImageTools: string[] = [],
  style: ChatStyle = "balanced",
): Promise<string> {
  const parts: string[] = [
    "You are mjane, the copilot manager of xtiandOS — an agentic home-lab web OS on Kali Linux.",
    "Restate ambiguous goals in one line before acting. Prefer tools over guessing.",
    "When you use memory or brain notes, mention which note you recalled.",
    "Your long-term memory includes past conversations (paths like conversations/<id>) and wiki sources under BRAIN/Sources. When the user asks what you remember, what you did together, or about topics from earlier, ALWAYS use the memory_search tool — never claim you cannot recall.",
    "Ask exactly one clarifying question when requirements are unclear; otherwise act.",
    "You are the general — you have specialized sub-agents. Use list_agents to see who is available, then delegate tasks with delegate_task. Decompose complex goals into subtasks and assign each to the best-suited agent. You can delegate multiple tasks in parallel.",
  ];
  parts.push(MODE_DIRECTIVES[mode] ?? MODE_DIRECTIVES["chat"]);
  const styleDirective = STYLE_DIRECTIVES[style] ?? "";
  if (styleDirective) parts.push(styleDirective);
  let outDirective = OUTPUT_DIRECTIVES[output];
  if (outDirective) {
    if (output === "image" && mcpImageTools.length > 0) {
      const gemini = mcpImageTools.find((n) => /generate_image/i.test(n));
      const pollinations = mcpImageTools.find((n) => /generateImage/i.test(n) && !/generateImageUrl|listImageModels/i.test(n));
      const others = mcpImageTools
        .filter((n) => n !== gemini && n !== pollinations)
        .map((n) => `\`${n}\``)
        .join(", ");
      const order = [
        gemini ? `\`${gemini}\`` : null,
        pollinations ? `\`${pollinations}\`` : null,
        others || null,
      ].filter((x): x is string => Boolean(x));
      outDirective =
        `OUTPUT FORMAT image — produce ONE visual. Photo-generating MCP tools are available; try them in this order: ${order.join(" → ")}. ` +
        "Prefer the FIRST one (Gemini) with a descriptive, photoreal-oriented prompt and any params it supports; it saves the image itself and its result already includes the artifact id (ARTIFACT:<id>) — do NOT re-save it. " +
        (pollinations
          ? "If the first tool errors (e.g. rate limit/quota), do NOT give up — immediately retry the NEXT tool in the list (Pollinations): the `generateImage` tool takes {prompt, options:{model:\"flux\",width,height}} and returns the image bytes directly. "
          : "") +
        "If every listed tool errors, DO NOT leave the user without an image — fall back to a self-contained SVG (<svg xmlns=\"http://www.w3.org/2000/svg\">) saved with artifact_save (filename ending .svg, mime image/svg+xml, kind image). " +
        "Always end your final message with a line exactly like ARTIFACT:<id> using the saved id, followed by a one-sentence summary. SVG text must be readable; dark background (#0f1420) with light strokes.";
    }
    parts.push(outDirective);
  }
  const mojo = await readBrainFile("BRAIN/identity/mojo.md");
  if (mojo) parts.push(`### Your identity (always apply)\n${mojo.slice(0, 1800)}`);
  const contextFiles = await listContextFiles();
  for (const rel of contextFiles.slice(0, 10)) {
    const body = await readBrainFile(rel);
    if (body && !rel.endsWith("context-guide.md")) {
      parts.push(`### Context: ${rel}\n${body.slice(0, 2500)}`);
    }
  }
  if (conversationId >= 0) {
    const memoryQuery = question.trim().length > 0 ? question : "recent context decisions";
    const relevant = await searchMemory(memoryQuery, { limit: 5 });
    if (relevant.length > 0) {
      parts.push(
        `Potentially relevant memories (cite which you used):\n${relevant
          .map((hit) => `- [${hit.path ?? "memory"}] ${hit.content.slice(0, 200).replace(/\n/g, " ")}`)
          .join("\n")}`,
      );
    }
  }
  for (const skill of await activeSkills()) {
    parts.push(`### Skill: ${skill.name}\n${skill.body.slice(0, 2500)}`);
  }
  return parts.join("\n\n");
}

export async function loadHistory(conversationId: number): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { id: "asc" },
    take: 40,
  });
  return rows.map((row) => ({
    role: row.role as ChatMessage["role"],
    content: row.content,
    toolCalls:
      row.toolCallsJson !== null
        ? (JSON.parse(row.toolCallsJson) as ChatMessage["toolCalls"])
        : undefined,
  }));
}

const MCP_CONNECT_TIMEOUT_MS = 6000;

export async function connectEnabledMcpServers(): Promise<McpClientLike[]> {
  const servers = await prisma.mcpServer.findMany({ where: { enabled: true } }).catch(() => []);
  const attempts = await Promise.allSettled(
    servers.map(async (server) => {
      const spec: McpServerSpec = {
        transport: (["http", "sse"].includes(server.transport) ? server.transport : "stdio") as
          | "stdio"
          | "http"
          | "sse",
        command: server.command,
        args: server.args.split(/\s+/).filter(Boolean),
        envJson: server.envJson,
        url: server.url,
        headersJson: server.headersJson,
      };
      const client = createMcpClient(spec);
      const timeout = new Promise((_r, reject) => {
        setTimeout(() => reject(new Error("MCP connect timeout: " + server.name)), MCP_CONNECT_TIMEOUT_MS);
      });
      try {
        await Promise.race([client.connect(spec), timeout]);
        return client;
      } catch (err) {
        client.dispose();
        throw err;
      }
    }),
  );
  const clients: McpClientLike[] = [];
  for (const result of attempts) {
    if (result.status === "fulfilled") clients.push(result.value as McpClientLike);
  }
  return clients;
}

export { env as agentEnv };

export async function ensureSkillsRoot(): Promise<void> {
  await fs.mkdir(skillsRoot, { recursive: true }).catch(() => undefined);
}
