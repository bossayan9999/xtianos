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
  /**
   * Attach an image (data URL) generated/read by a tool so a vision-capable
   * model can actually see it on the next turn. The loop collects these and
   * sends them as image_url parts to the provider.
   */
  attachImage?: (dataUrl: string) => void;
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
