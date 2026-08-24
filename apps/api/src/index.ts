import path from "node:path";

import express from "express";

import { authMiddleware, audit } from "./lib/auth";
import { env } from "./lib/env";
import { prisma } from "./lib/db";
import { chatRouter } from "./routes/chat";
import { providersRouter } from "./routes/providers";
import { brainRouter } from "./routes/brain";
import { projectsRouter, tasksRouter } from "./routes/projects";
import { skillsRouter } from "./routes/skills";
import { artifactsRouter, auditRouter, dockerRouter, execRouter } from "./routes/misc";
import { mcpRouter, memoryRouter } from "./routes/mcp";
import { voiceRouter } from "./routes/voice";
import { ensureSkillsRoot } from "./services/agent-service";
import { promises as fsp, existsSync } from "node:fs";

const app = express();
const port = Number.parseInt(process.env["PORT"] ?? "3101", 10);

app.use(express.json({ limit: "20mb" }));
app.use(authMiddleware);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", app: "xtiandOS", timestamp: new Date().toISOString() });
});

app.use("/api/chat", chatRouter);
app.use("/api/providers", providersRouter);
app.use("/api/brain", brainRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/docker", dockerRouter);
app.use("/api/exec", execRouter);
app.use("/api/artifacts", artifactsRouter);
app.use("/api/audit", auditRouter);
app.use("/api/mcp", mcpRouter);
app.use("/api/memory", memoryRouter);
app.use("/api/voice", voiceRouter);

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

  app.listen(port, env.bind, () => {
    void audit("boot", `xtiandOS API on ${env.bind}:${port}`);
    console.log(`xtiandOS API listening at http://${env.bind}:${port}`);
  }).on("error", (error: Error) => {
    console.error("API failed to start:", error.message);
    process.exit(1);
  });
}

void bootstrap();
