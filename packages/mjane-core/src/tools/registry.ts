import type { ToolDef, ToolContext } from "../types";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  async execute(
    name: string,
    argsJson: string,
    ctx: ToolContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `ERROR unknown tool: ${name}`;
    }
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(argsJson || "{}") as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "ERROR arguments must be a JSON object";
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return "ERROR arguments are not valid JSON";
    }
    for (const param of tool.params) {
      if (!param.required) continue;
      const value = args[param.name];
      if (value === undefined || value === null || value === "") {
        return `ERROR missing required parameter: ${param.name}`;
      }
      const expected = param.type === "number" ? "number" : typeof value;
      if (expected !== param.type && !(param.type === "string" && typeof value === "string")) {
        return `ERROR parameter ${param.name} must be ${param.type}`;
      }
    }
    try {
      return await tool.run(args, ctx);
    } catch (error: unknown) {
      return `ERROR ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`;
    }
  }
}
