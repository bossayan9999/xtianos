# ✨ xtiandOS

Agentic home-lab web OS for Kali Linux with **mjane**, the copilot manager.

## Run it

```bash
npm install
npm run db:push        # first time only
cp .env.example .env   # set MASTER_SECRET!
npm run dev:api &      # http://localhost:3101
npm run dev:web        # http://localhost:5174
```

CLI: `node apps/cli/bin/xos.mjs` (or `npm link -w apps/cli` → `xos ask "..."`)

## MCP

xtiandOS is both an **MCP host** (client) and an **MCP server**.

### As a client (mjane uses external MCP servers)

Manage servers in 🧩 **Skills & MCP**:

- **stdio** servers — local tools like the reference filesystem or sequential-thinking servers:
  `npx -y @modelcontextprotocol/server-filesystem ./`
- **Streamable HTTP** servers — remote tools with optional auth headers
- Add servers in the UI, or declare them in `mcp.json` (claude_desktop_config.json-compatible
  format) and press **Sync mcp.json**. Reference: `mcp.example.json`.
- Each server can be probed to list its **tools**, **resources**, and **prompts**; resources and
  prompts can be read/fetched from the UI.

Enabled servers are connected at chat time and their tools are exposed to mjane as `mcp_<tool>`.

### As a server (any MCP client connects to xtiandOS)

Packet `packages/mcp-server` exposes the brain, memory, chat, message bus, shell, docker, and
artifact tools plus resources, prompts, roots, and sampling:

```bash
# stdio (point any MCP client at this command)
node --import tsx packages/mcp-server/src/index.ts

# Streamable HTTP (http://0.0.0.0:8942)
XTIANDOS_MCP_PORT=8942 node --import tsx packages/mcp-server/src/http-server.ts
```

Capabilities: `tools`, `resources` (subscribe + listChanged), `prompts`, `roots`, `sampling`.
Configure from `mcp.json`:

```json
{
  "mcpServers": {
    "xtiandos": {
      "command": "node",
      "args": ["--import", "tsx", "/abs/path/xtiandOS/packages/mcp-server/src/index.ts"]
    }
  }
}
```

## What mjane can do

| Area | Where |
|---|---|
| Multi-model chat (searchable picker, encrypted API keys) | 💬 mjane + ⚙️ Settings |
| Obsidian vault brain — read/write/clean/RAG memory | 🧠 Brain |
| Skills (`SKILL.md`, install from GitHub) + MCP servers | 🧩 Skills & MCP |
| Projects + kanban workflow tasks (drag & drop) | 📋 Projects |
| Artifact generation (code/docs/SVG/images) | 🎨 Studio |
| Sandboxed shell (audit-logged, destructive-blocked) + Docker control | ⌨️ Terminal |

## Architecture

- `apps/api` — Express + Prisma 7 (SQLite) + agent orchestration
- `apps/web` — React 19 + Vite, dark theme
- `apps/cli` — `xos` terminal companion
- `packages/shared` — domain types
- `packages/mjane-core` — providers, plan→act→observe loop, tools, hybrid RAG
- `packages/mcp-bridge` — MCP stdio client (connect any MCP server)

Memory: vault notes are chunked + embedded into `MemoryChunk`; retrieval =
cosine (50%) + keyword overlap (40%) + recency decay (10%). Reindex from the
Brain page. Provider embeddings upgrade automatically when a key works.

## Rules

- No unprompted commits. Tests required per feature (`npm test`).
- Never commit `.env` / `*.db` / installed skills.
