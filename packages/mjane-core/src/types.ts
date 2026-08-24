import type { ChatMessage, ProviderKind } from "@xtiand/shared";

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export type ToolScope = "read" | "fs-write" | "net" | "exec";

export interface ToolContext {
  vaultPath: string;
  workspaceDir: string;
  /** present when the call originates from a conversation */
  conversationId: number | null;
  emit: (event: { type: string; data: unknown }) => void;
}

export interface ToolDef {
  name: string;
  description: string;
  scopes: ToolScope[];
  params: ToolParam[];
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ProviderConfigDto {
  id: number;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  hasKey: boolean;
}

export interface AgentLoopInput {
  messages: ChatMessage[];
  tools: ToolDef[];
  provider: {
    kind: ProviderKind;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  maxTurns?: number;
  onStep: (event: { type: string; data: unknown }) => void;
}
