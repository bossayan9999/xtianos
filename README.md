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
