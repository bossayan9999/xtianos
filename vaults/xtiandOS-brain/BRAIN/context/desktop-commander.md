---
updated: 2026-09-03
type: context
purpose: system-prompt
agent: mjane
status: core
---

# Desktop Commander MCP — mjane's desktop access

## What it is

**Desktop Commander** (`@wonderwhy-er/desktop-commander`) is an MCP server that gives mjane filesystem read/write/search and terminal process management on Christian's Windows desktop.

Installed **2026-09-03** via xtiandOS's MCP bridge (`mcp-bridge` → stdio transport → `connectEnabledMcpServers()`).

## How it works

- Registered as `desktop-commander` (id=2) in the `McpServer` DB table and in `repo/mcp.json`
- Spawned via `npx -y @wonderwhy-er/desktop-commander@latest --no-onboarding` on every chat run
- Tools appear as `mcp_<toolname>` (prefixed by `chat.ts`'s MCP registration loop)
- Transport: stdio via `McpStdioClient` (6s connect timeout in `agent-service.ts`)

## Available tools (26 total)

### Filesystem
- `mcp_read_file` — read file contents from Desktop
- `mcp_read_multiple_files` — batch read
- `mcp_write_file` — create/overwrite files (append mode available)
- `mcp_edit_block` — surgical search-and-replace edits
- `mcp_list_directory` — list files/folders
- `mcp_create_directory` — create folders
- `mcp_move_file` — move/rename
- `mcp_start_search` — file name/content search (streaming)
- `mcp_get_file_info` — metadata
- `mcp_write_pdf` — create PDFs from Markdown

### Terminal / Process management
- `mcp_start_process` — launch a terminal (PowerShell on Windows)
- `mcp_read_process_output` — read terminal output
- `mcp_interact_with_process` — send input to a running process
- `mcp_force_terminate` — kill a terminal session
- `mcp_list_sessions` / `mcp_list_processes` / `mcp_kill_process`

### Configuration
- `mcp_get_config` — view current config
- `mcp_set_config_value` — change config at runtime

## Security scoping

Config file: `~/.desktop-commander/config.json`

```json
{
  "allowedDirectories": ["C:\\Users\\Christian\\Desktop"],
  "defaultShell": "powershell",
  "telemetryEnabled": false,
  "blockedCommands": ["rm -rf /", "format", "del /s /q C:\\", "shutdown", "reboot", ...]
}
```

**Important:** `allowedDirectories` only scopes **filesystem tools** (read_file, write_file, etc.). Terminal commands (`start_process`) bypass this entirely — a `Get-Content C:\...` via PowerShell works regardless of directory scoping.

## Known gotcha — startup latency

Desktop Commander npx startup takes ~8 seconds on a warm cache (longer on first run). The API's `connectEnabledMcpServers()` timeout is **6 seconds** (`MCP_CONNECT_TIMEOUT_MS` in `agent-service.ts`). On the first chat message after an API restart, this MCP server may time out and be skipped. Second message onward (npx warmed) connects fine.

**Fix if it's a problem:** bump `MCP_CONNECT_TIMEOUT_MS` to ~15000 in `apps/api/src/services/agent-service.ts`, or install globally: `npm install -g @wonderwhy-er/desktop-commander`.

## Files changed

| File | What |
| --- | --- |
| `repo/mcp.json` | Added `desktop-commander` entry alongside `firecrawl` |
| `apps/api/prisma/dev.db` | `McpServer` row id=2 (via direct SQLite insert) |
| `~/.desktop-commander/config.json` | Created with `allowedDirectories` scoped to Desktop |

## Usage example

After mjane connects, you can ask her things like:
- "Read the file on my Desktop called notes.md"
- "Create a new file on my Desktop called todo.txt with today's tasks"
- "List everything on my Desktop"
- "Search my Desktop for files containing 'invoice'"
- "Edit the header in report.md on my Desktop"

She'll use the `mcp_read_file`, `mcp_write_file`, `mcp_list_directory`, etc. tools automatically.
