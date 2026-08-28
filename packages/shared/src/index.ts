export const PROVIDER_KINDS = [
  "openai-compat",
  "anthropic",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const CHAT_ROLES = ["system", "user", "assistant", "tool"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export interface ToolCallDto {
  id: string;
  name: string;
  argsJson: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCallDto[];
  toolCallId?: string;
  /** data-URL images (vision-capable models only) */
  images?: string[];
}

export interface ModelInfo {
  id: string;
  label: string;
  providerId: number | null;
  kind: ProviderKind | null;
}

export interface ConversationSummary {
  id: number;
  title: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: number;
  role: ChatRole;
  content: string;
  toolCalls: ToolCallDto[];
  createdAt: string;
}

export type TaskStatus = "inbox" | "doing" | "blocked" | "done";
export const TASK_STATUSES: readonly TaskStatus[] = [
  "inbox",
  "doing",
  "blocked",
  "done",
];

export interface Task {
  id: number;
  projectId: number | null;
  title: string;
  status: TaskStatus;
  notes: string | null;
  position: number;
  createdAt: string;
}

export interface Project {
  id: number;
  name: string;
  goal: string | null;
  status: "active" | "paused" | "done";
  createdAt: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  whenToUse: string[];
  allowedTools: string[];
  dirName: string;
  enabled: boolean;
  source: "builtin" | "github" | "local";
}

export interface BrainNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  updatedAt: string;
}

export interface BrainSearchHit {
  path: string;
  score: number;
  snippet: string;
}

export interface Artifact {
  id: number;
  conversationId: number | null;
  kind: "text" | "code" | "image" | "video" | "other";
  filename: string;
  mime: string;
  contentBase64: string | null;
  textPreview: string | null;
  createdAt: string;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  id: number;
  name: string;
  transport?: McpTransport;
  command: string;
  args: string;
  envJson: string;
  /** Remote endpoint URL for http/sse transports */
  url?: string;
  /** JSON map of extra headers to send (e.g. auth) */
  headersJson?: string;
  /** OAuth connection state for remote servers: unlinked | linking | linked */
  oauth?: "none" | "linking" | "linked";
  enabled: boolean;
}

export interface AuditEntry {
  id: number;
  action: string;
  detail: string;
  createdAt: string;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type McpServerStatsCaps =
  | { kind: "tools"; items: McpToolInfo[] }
  | { kind: "resources"; items: McpResourceInfo[] }
  | { kind: "prompts"; items: McpPromptInfo[] };

export interface AgentStepEvent {
  type: "status" | "token" | "tool-start" | "tool-end" | "message" | "error" | "done";
  data: unknown;
}
