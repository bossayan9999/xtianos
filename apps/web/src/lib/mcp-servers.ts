import type { McpTransport } from '@xtiand/shared'

export interface KnownMcpServer {
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string
  url?: string
}

/** Curated catalog of popular MCP servers, searchable from the add-server combobox. */
export const knownMcpServers: KnownMcpServer[] = [
  {
    name: 'xtiandos',
    description: 'xtiandOS itself — brain, memory, shell, docker, artifacts',
    transport: 'stdio',
    command: 'node',
    args: '--import tsx /ABS/PATH/xtiandOS/packages/mcp-server/src/index.ts',
  },
  {
    name: 'filesystem',
    description: 'Read/write files in allowed directories',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem ./',
  },
  {
    name: 'sequential-thinking',
    description: 'Structured thinking + problem decomposition',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-sequential-thinking',
  },
  {
    name: 'memory',
    description: 'Knowledge-graph persistent memory',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-memory',
  },
  {
    name: 'fetch',
    description: 'Fetch a URL, strip noise, convert to markdown',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-fetch',
  },
  {
    name: 'git',
    description: 'Git operations: log, diff, status, search, blame',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-git',
  },
  {
    name: 'github',
    description: 'GitHub API: repos, issues, PRs, actions (needs GH_TOKEN)',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-github',
  },
  {
    name: 'brave-search',
    description: 'Web + local news search (needs BRAVE_API_KEY)',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-brave-search',
  },
  {
    name: 'context7',
    description: 'Up-to-date library / API documentation retrieval',
    transport: 'stdio',
    command: 'npx',
    args: '-y @upstash/context7-mcp',
  },
  {
    name: 'firecrawl',
    description: 'Crawl, scrape, and extract websites (needs FIRECRAWL_API_KEY)',
    transport: 'stdio',
    command: 'npx',
    args: '-y firecrawl-mcp',
  },
  {
    name: 'playwright',
    description: 'Browser automation: navigate, click, screenshot',
    transport: 'stdio',
    command: 'npx',
    args: '-y @playwright/mcp',
  },
  {
    name: 'markdownify',
    description: 'Convert MCP tool output into clean markdown',
    transport: 'stdio',
    command: 'npx',
    args: '-y markdownify-mcp',
  },
  {
    name: 'sqlite',
    description: 'Query and mutate SQLite databases',
    transport: 'stdio',
    command: 'uvx',
    args: 'mcp-server-sqlite --db-path ./local.db',
  },
  {
    name: 'time',
    description: 'Time and timezone conversion',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-time --local-timezone US/Pacific',
  },
  {
    name: 'everything',
    description: 'Reference server with every MCP primitive',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-everything',
  },
  {
    name: 'chroma',
    description: 'Vector search / embeddings store (needs CHROMA_URL)',
    transport: 'http',
    url: 'http://localhost:8000',
  },
  {
    name: 'puppeteer',
    description: 'Browser automation via puppeteer',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-puppeteer',
  },
  {
    name: 'supabase',
    description: 'Postgres/Supabase database queries',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-postgres "postgresql://user:pass@host:5432/db"',
  },
  {
    name: 'slack',
    description: 'Read/write Slack messages (remotes via Streamable HTTP)',
    transport: 'http',
    url: 'https://example.com/slack/mcp',
  },
  {
    name: 'notion',
    description: 'Notion pages, databases, search',
    transport: 'http',
    url: 'https://example.com/notion/mcp',
  },
]