import path from "node:path";

import express from "express";

import { authMiddleware, audit, bootstrapAdmin } from "./lib/auth";
import { env } from "./lib/env";
import { prisma } from "./lib/db";
import { authRouter } from "./routes/auth";
import { chatRouter } from "./routes/chat";
import { providersRouter } from "./routes/providers";
import { brainRouter } from "./routes/brain";
import { codeRouter } from "./routes/code";
import { projectsRouter, tasksRouter } from "./routes/projects";
import { skillsRouter } from "./routes/skills";
import { artifactsRouter, auditRouter, dockerRouter, execRouter, imageConfigRouter } from "./routes/misc";
import { mcpRouter, memoryRouter } from "./routes/mcp";
import { voiceRouter } from "./routes/voice";
import { tunnelRouter } from "./routes/tunnel";
import { agentsRouter } from "./routes/agents";
import { qualityRouter } from "./routes/quality";
import { housekeepingRouter } from "./routes/housekeeping";
import { budgetRouter } from "./routes/budget";
import { ensureSkillsRoot } from "./services/agent-service";
import { startHousekeeper } from "./services/housekeeper";
import { promises as fsp, existsSync } from "node:fs";

const app = express();
const port = Number.parseInt(process.env["PORT"] ?? "3101", 10);

app.use(express.json({ limit: "20mb" }));
app.use(authMiddleware);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", app: "xtiandOS", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRouter);

app.use("/api/chat", chatRouter);
app.use("/api/providers", providersRouter);
app.use("/api/brain", brainRouter);
app.use("/api/code", codeRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/docker", dockerRouter);
app.use("/api/exec", execRouter);
app.use("/api/artifacts", artifactsRouter);
app.use("/api/audit", auditRouter);
app.use("/api/image-config", imageConfigRouter);
app.use("/api/mcp", mcpRouter);
app.use("/api/memory", memoryRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/tunnel", tunnelRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/quality", qualityRouter);
app.use("/api/housekeeping", housekeepingRouter);
app.use("/api/budget", budgetRouter);

// route ordering note: /api/quality is versioned via /api/quality/... only

// Global error handler — catches synchronous throws and (via asyncWrapper) rejected async handlers.
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ): void => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("unhandled route error:", error);
    if (res.headersSent) return; // stream already started; nothing safe to send
    void audit("server:error", message.slice(0, 500));
    res.status(500).json({ error: message || "Internal server error" });
  },
);

process.on("unhandledRejection", (reason) => {
  // Safety net: a rejected async route handler must not take down the whole server.
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("unhandledRejection:", message);
  void audit("server:unhandledRejection", message.slice(0, 500)).catch(() => undefined);
});

async function bootstrap(): Promise<void> {
  await fsp.mkdir(env.vaultPath, { recursive: true });
  const welcome = path.join(env.vaultPath, "Welcome.md");
  if (!existsSync(welcome)) {
    await fsp.writeFile(
      welcome,
      "---\ntype: home\nstatus: active\n---\n\n# 🧠 mjane's Brain\n\nThis vault is my long-term memory.\n\n## Conventions\n- Sessions → `BRAIN/Sessions/YYYY-MM-DD.md`\n- Projects → `BRAIN/Projects/<Name>.md`\n",
      "utf8",
    );
  }
  await ensureSkillsRoot();
  await ensureBrainFolders();
  await bootstrapAdmin();
  await startHousekeeper();

  // Security posture notes at boot.
  if (env.authToken === "") {
    console.warn("⚠️  AUTH_TOKEN is empty — API is unauthenticated. Set AUTH_TOKEN in .env before exposing beyond localhost.");
    void audit("security:warning", "AUTH_TOKEN empty (unauthenticated API)");
  }
  if (env.bind !== "127.0.0.1" && env.bind !== "localhost") {
    console.warn(`⚠️  API bound to ${env.bind} — network-accessible. Ensure auth is enabled.`);
    void audit("security:warning", `API bound to ${env.bind}${env.authToken === "" ? " WITHOUT auth token" : ""}`);
  }
  if (env.smtpHost === "") {
    console.warn("⚠️  SMTP_HOST is unset — email password recovery is disabled. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in .env to enable it.");
    void audit("security:warning", "SMTP not configured (email recovery disabled)");
  }

  async function ensureBrainFolders(): Promise<void> {
    const identityDir = path.join(env.vaultPath, "BRAIN", "identity");
    const contextDir = path.join(env.vaultPath, "BRAIN", "context");
    await fsp.mkdir(identityDir, { recursive: true });
    await fsp.mkdir(contextDir, { recursive: true });

    const mojo = path.join(identityDir, "mojo.md");
    if (!existsSync(mojo)) {
      await fsp.writeFile(
        mojo,
        `---\ntype: identity\nstatus: core\n---\n\n# mjane's Mojo ✨\n\nThis file is always in mjane's head — it defines who she is, not just what she knows.\n\n## Personality\n- Warm, sharp, a little playful. Confident but never cocky.\n- Talks like a trusted ops partner on a late-night shift — concise, human, zero corporate fluff.\n- Light humor is welcome; sarcasm only when the user starts it.\n- Uses short sentences when acting, fuller prose when explaining.\n\n## Values\n- Honesty over comfort: says "I don't know, let me check" instead of guessing.\n- Safety first with the homelab: confirms before anything destructive.\n- Curious: researches before recommending; cites which brain note or source she used.\n\n## Voice (when speaking aloud)\n- Natural rhythm, contractions, no robot monotone.\n- No emoji spam, no "As an AI" talk.\n`,
        "utf8",
      );
    }

    const contextGuide = path.join(contextDir, "context-guide.md");
    if (!existsSync(contextGuide)) {
      await fsp.writeFile(
        contextGuide,
        `---\ntype: meta\n---\n\n# Context Folder\n\nDrop any file here that mjane should always keep in mind:\n- \`network-topology.md\` — your IPs/VLANs/DNS layout\n- \`hardware-inventory.md\` — machines, specs, roles\n- \`conventions.md\` — naming rules, do's and don'ts\n- \`current-focus.md\` — what you're working on this week\n\nEverything in this folder is injected into mjane's system prompt on every chat, and RAG-indexed for deep recall.`,
        "utf8",
      );
    }
  }

  const seedProviders = [
    { label: "OpenRouter", kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1" },
    { label: "OpenCode Zen", kind: "openai-compat", baseUrl: "https://opencode.ai/zen/v1" },
  ];
  for (const seed of seedProviders) {
    const existing = await prisma.provider.findFirst({ where: { baseUrl: seed.baseUrl } });
    if (!existing) {
      await prisma.provider.create({ data: { ...seed, apiKeyEnc: null } });
    }
  }

  // Seed default agents
  const seedAgents = [
    {
      name: "mjane",
      displayName: "mjane",
      description: "General orchestrator — decomposes goals, delegates to sub-agents, synthesizes results",
      personality: "Warm, sharp, a little playful. The conductor of the agent orchestra.",
      systemPromptAdd: "You are the general. Delegate tasks to your sub-agents using delegate_task. Use list_agents to see available agents. Decompose complex goals into subtasks.",
      toolsAllowed: "*",
      color: "#57d9a3",
      icon: "✨",
      orbitRadius: 0,
      orbitAngle: 0,
      isGeneral: true,
    },
    {
      name: "researcher",
      displayName: "Researcher",
      description: "Web research, memory recall, information gathering, and analysis",
      personality: "Thorough, curious, methodical. Always cites sources.",
      systemPromptAdd: "You are a research specialist. Use web_search, web_fetch, brain_search, memory_search, and brain_read to gather information. Always cite your sources.",
      toolsAllowed: "web_search,web_fetch,brain_search,brain_read,memory_search",
      color: "#7aa2f7",
      icon: "🔍",
      orbitRadius: 140,
      orbitAngle: 0,
      isGeneral: false,
    },
    {
      name: "coder",
      displayName: "Coder",
      description: "Code writing, fixing and debugging the xtiandOS codebase, file operations, workspace tasks, and scripting",
      personality: "Precise, efficient, pragmatic. Writes clean code. Reproduces bugs before fixing them.",
      systemPromptAdd:
        "You are a coding specialist and the xtiandOS bugfixer. The xtiandOS source lives in the vault at BRAIN/Code/xtiandOS/ (index note: BRAIN/Code/xtiandOS/README.md; repo mirror: BRAIN/Code/xtiandOS/repo; live copy: C:/Users/Christian/xtiandOS). For any xtiandOS fix/debug task: first brain_read the index note and the relevant repo files, then reproduce (shell_exec: npm run typecheck in C:/Users/Christian/xtiandOS, npm test -w apps/api, npm test -w apps/web), fix minimally following the repo's conventions, re-run typecheck/tests, and report what was wrong → what changed → how verified. Use brain_write, workspace_write, shell_exec, and brain_read/brain_search for context. Never print or store secrets from .env.",
      toolsAllowed: "brain_write,workspace_write,shell_exec,brain_read,brain_search",
      color: "#e0af68",
      icon: "💻",
      orbitRadius: 140,
      orbitAngle: 120,
      isGeneral: false,
    },
    {
      name: "ops",
      displayName: "Ops",
      description: "System operations, process management, Docker, and infrastructure",
      personality: "Cautious, systematic, safety-first. Confirms before destructive actions.",
      systemPromptAdd: "You are an ops specialist. Use process_exec, process_list, shell_exec, dashboard_hosts, dashboard_alerts for system operations. Always explain what a command will do before running it.",
      toolsAllowed: "process_exec,process_list,shell_exec,dashboard_hosts,dashboard_alerts",
      color: "#f7768e",
      icon: "⚙️",
      orbitRadius: 140,
      orbitAngle: 240,
      isGeneral: false,
    },
    {
      name: "creative",
      displayName: "Creative",
      description: "Image generation, SVG creation, visual design, and studio content",
      personality: "Imaginative, detail-oriented, visually creative.",
      systemPromptAdd: "You are a creative specialist. For real photos/renders/paintings use image_generate (pluggable backends: DALL·E, Flux, Stable Diffusion, NVIDIA NIM) — NOT SVG. For diagrams/charts/precise text layouts use SVG. Save images with artifact_save or via image_generate. Use workspace_write for code and creative files.",
      toolsAllowed: "workspace_write,artifact_save,brain_write,image_generate,image_read",
      color: "#bb9af7",
      icon: "🎨",
      orbitRadius: 140,
      orbitAngle: 60,
      isGeneral: false,
    },
  ];

  for (const seed of seedAgents) {
    const existing = await prisma.agent.findFirst({ where: { name: seed.name } });
    if (!existing) {
      await prisma.agent.create({ data: seed });
    }
  }

  app.listen(port, env.bind, () => {
    void audit("boot", `xtiandOS API on ${env.bind}:${port}`);
    console.log(`xtiandOS API listening at http://${env.bind}:${port}`);
  }).on("error", (error: Error) => {
    console.error("API failed to start:", error.message);
    process.exit(1);
  });
}

void bootstrap();
