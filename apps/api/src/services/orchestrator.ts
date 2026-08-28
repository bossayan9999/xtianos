import { runAgentLoop, ToolRegistry, builtinTools } from "@xtiand/mjane-core";
import type { ToolDef, ToolContext } from "@xtiand/mjane-core";
import type { ChatMessage } from "@xtiand/shared";
import { prisma } from "../lib/db";
import { decryptSecret, env } from "../lib/env";
import { audit } from "../lib/auth";
import { searchMemory } from "./memory";
import { dashboardTools } from "./dashboard-tools";
import { imageTool, imageReadTool } from "./image-tools";

// ── Agent config type ─────────────────────────────────────────────────────────

interface AgentConfig {
  id: number;
  name: string;
  displayName: string;
  description: string;
  personality: string;
  systemPromptAdd: string;
  toolsAllowed: string;
  providerId: number | null;
  model: string | null;
  apiKeyEnc: string | null;
  status: string;
  isGeneral: boolean;
  enabled: boolean;
}

// ── Resolve provider for an agent ─────────────────────────────────────────────

async function resolveAgentProvider(agent: AgentConfig): Promise<{
  kind: "openai-compat" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}> {
  // Agent's own provider
  if (agent.providerId) {
    const provider = await prisma.provider.findUnique({ where: { id: agent.providerId } });
    if (provider) {
      const key = agent.apiKeyEnc
        ? decryptSecret(agent.apiKeyEnc)
        : provider.apiKeyEnc
          ? decryptSecret(provider.apiKeyEnc)
          : "";
      if (key && agent.model) {
        return {
          kind: provider.kind === "anthropic" ? "anthropic" : "openai-compat",
          baseUrl: provider.baseUrl,
          apiKey: key,
          model: agent.model,
        };
      }
    }
  }

  // Fallback: global default
  const defaultSpec = (await prisma.setting.findUnique({ where: { key: "defaultModel" } }))?.value ?? null;
  let providerId: number;
  let model: string;

  if (defaultSpec !== null && /^\d+:/.test(defaultSpec)) {
    providerId = Number.parseInt(defaultSpec.slice(0, defaultSpec.indexOf(":")), 10);
    model = defaultSpec.slice(defaultSpec.indexOf(":") + 1);
  } else {
    const first = await prisma.provider.findFirst({ orderBy: { id: "asc" } });
    if (!first) throw new Error("No AI provider configured");
    providerId = first.id;
    model = defaultSpec ?? first.label;
  }

  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error("Configured provider no longer exists");

  return {
    kind: provider.kind === "anthropic" ? "anthropic" : "openai-compat",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKeyEnc ? decryptSecret(provider.apiKeyEnc) : "",
    model,
  };
}

// ── Build tool registry for a sub-agent ───────────────────────────────────────

function buildAgentRegistry(agent: AgentConfig): ToolRegistry {
  const registry = new ToolRegistry();
  const allowed = agent.toolsAllowed === "*"
    ? null
    : new Set(agent.toolsAllowed.split(",").map((s) => s.trim()).filter(Boolean));

  for (const tool of builtinTools(env.workspaceDir)) {
    if (allowed && !allowed.has(tool.name)) continue;
    registry.register(tool);
  }

  if (!allowed || allowed.has("dashboard_hosts") || allowed.has("dashboard_alerts")) {
    for (const tool of dashboardTools()) {
      if (allowed && !allowed.has(tool.name)) continue;
      registry.register(tool);
    }
  }

  if (!allowed || allowed.has("memory_search")) {
    registry.register({
      name: "memory_search",
      description: "Search long-term memory for relevant context.",
      scopes: ["read"],
      params: [{ name: "query", type: "string", description: "what to recall", required: true }],
      run: async (args: Record<string, unknown>) => {
        const hits = await searchMemory(String(args["query"] ?? ""), { limit: 6 });
        return JSON.stringify(hits, null, 2);
      },
    });
  }

  // Real image generation (photorealistic raster images via pluggable backends).
  // Available when explicitly allowed, or when the agent has full/relevant access.
  const imgTool = imageTool({
    enabled: allowed === null || allowed.has("image_generate"),
  });
  if (imgTool) registry.register(imgTool);

  // View images (vision read-back) so the agent can actually see them.
  if (allowed === null || allowed.has("image_read")) {
    registry.register(imageReadTool());
  }

  return registry;
}

// ── Build system prompt for a sub-agent ───────────────────────────────────────

function buildAgentPrompt(agent: AgentConfig): string {
  const parts: string[] = [];

  parts.push(
    `You are ${agent.displayName}, a specialized agent in the xtiandOS multi-agent system.`,
    `Your role: ${agent.description}`,
  );

  if (agent.personality) {
    parts.push(`### Personality\n${agent.personality}`);
  }

  if (agent.systemPromptAdd) {
    parts.push(`### Instructions\n${agent.systemPromptAdd}`);
  }

  parts.push(
    "You are one of mjane's sub-agents. Complete your assigned task thoroughly and report results back.",
    "Be concise but thorough. Use tools when they help. Always cite what you did.",
  );

  return parts.join("\n\n");
}

// ── Run a sub-agent delegation ────────────────────────────────────────────────

export interface DelegateResult {
  agentName: string;
  agentDisplayName: string;
  response: string;
  turnsUsed: number;
}

export async function delegateToAgent(
  agentId: number,
  task: string,
  context: string | undefined,
  parentConversationId: number,
  onStep: (event: { type: string; data: unknown }) => void,
): Promise<DelegateResult> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error(`Agent #${agentId} not found`);
  if (!agent.enabled) throw new Error(`Agent ${agent.displayName} is disabled`);

  // Update status to working
  await prisma.agent.update({ where: { id: agentId }, data: { status: "working" } });

  try {
    const provider = await resolveAgentProvider(agent);
    const registry = buildAgentRegistry(agent);
    const systemPrompt = buildAgentPrompt(agent);

    const userMessage = context
      ? `Task: ${task}\n\nContext:\n${context}`
      : `Task: ${task}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    onStep({
      type: "delegate",
      data: { agentId: agent.id, agentName: agent.displayName, task: task.slice(0, 200) },
    });

    const result = await runAgentLoop({
      messages,
      maxTurns: 12,
      maxToolCalls: 20,
      registry,
      ctx: {
        vaultPath: env.vaultPath,
        workspaceDir: env.workspaceDir,
        conversationId: parentConversationId,
        emit: () => undefined,
      },
      provider,
      onStep: (step) => {
        // Re-emit with agent attribution
        onStep({
          type: "sub-agent",
          data: {
            agentId: agent.id,
            agentName: agent.displayName,
            ...step,
          },
        });
      },
      onToken: () => undefined,
    });

    const finalMsg = [...result.messages].reverse().find((m) => m.role === "assistant");
    const response = finalMsg?.content ?? "(no response)";

    // Update status to idle
    await prisma.agent.update({ where: { id: agentId }, data: { status: "idle" } });

    onStep({
      type: "delegate-result",
      data: { agentId: agent.id, agentName: agent.displayName, result: response.slice(0, 1000) },
    });

    await audit(`agent:delegate`, `${agent.displayName}: ${task.slice(0, 100)}`);

    return {
      agentName: agent.name,
      agentDisplayName: agent.displayName,
      response,
      turnsUsed: result.turnsUsed,
    };
  } catch (err) {
    await prisma.agent.update({ where: { id: agentId }, data: { status: "error" } });
    throw err;
  }
}

// ── Orchestrate tools for mjane ───────────────────────────────────────────────

export function orchestrateTools(): ToolDef[] {
  return [
    {
      name: "delegate_task",
      description:
        "Delegate a task to a specialized sub-agent. The agent will work independently and return results. Use list_agents first to see available agents and their capabilities.",
      scopes: ["read"],
      params: [
        { name: "agentId", type: "number", description: "ID of the agent to delegate to", required: true },
        { name: "task", type: "string", description: "Clear task description for the agent", required: true },
        { name: "context", type: "string", description: "Additional context or background for the task", required: false },
      ],
      run: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const agentId = Number(args["agentId"]);
        const task = String(args["task"] ?? "");
        const context = typeof args["context"] === "string" ? args["context"] : undefined;

        if (Number.isNaN(agentId) || task.length === 0) {
          return "ERROR: agentId (number) and task (string) are required";
        }

        const result = await delegateToAgent(
          agentId,
          task,
          context,
          ctx.conversationId ?? 0,
          (event) => {
            // Emit delegation events through the tool context
            // These flow up through runAgentLoop's onStep to the SSE stream
            ctx.emit({ type: "delegate", data: event });
          },
        );

        return `[${result.agentDisplayName}] completed in ${result.turnsUsed} turns:\n\n${result.response}`;
      },
    },
    {
      name: "list_agents",
      description: "List all available agents, their status, capabilities, and current model configuration.",
      scopes: ["read"],
      params: [],
      run: async () => {
        const agents = await prisma.agent.findMany({
          where: { enabled: true },
          orderBy: { isGeneral: "desc" },
        });

        const lines = agents.map((a) => {
          const modelInfo = a.model ? `${a.providerId}:${a.model}` : "default";
          const tools = a.toolsAllowed === "*" ? "all" : a.toolsAllowed;
          return [
            `### ${a.icon} ${a.displayName} (${a.status})`,
            `- ID: ${a.id}`,
            `- Role: ${a.description}`,
            `- Model: ${modelInfo}`,
            `- Tools: ${tools}`,
            `- General: ${a.isGeneral ? "yes" : "no"}`,
          ].join("\n");
        });

        return lines.join("\n\n");
      },
    },
  ];
}
