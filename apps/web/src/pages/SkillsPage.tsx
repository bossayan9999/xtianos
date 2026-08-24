import { useEffect, useState } from 'react'
import type { McpServerConfig, SkillManifest } from '@xtiand/shared'

import { api } from '../lib/api'

export function SkillsPage() {
  const [skills, setSkills] = useState<(SkillManifest & { id: number })[]>([])
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState('')
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [mcpName, setMcpName] = useState('')
  const [mcpCommand, setMcpCommand] = useState('')

  const load = (): void => {
    api.get<(SkillManifest & { id: number })[]>('/api/skills').then(setSkills).catch(() => undefined)
    api.get<McpServerConfig[]>('/api/mcp/servers').then(setServers).catch(() => undefined)
  }

  useEffect(load, [])

  const install = async (): Promise<void> => {
    setStatus('installing…')
    try {
      const r = await api.post<{ installed: string[] }>('/api/skills/install-github', { url })
      setUrl('')
      setStatus(`installed: ${r.installed.join(', ') || 'no SKILL.md folders found'}`)
      load()
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const toggle = async (skill: SkillManifest): Promise<void> => {
    await api.patch(`/api/skills/${skill.dirName}`, { enabled: !skill.enabled })
    load()
  }

  const addServer = async (): Promise<void> => {
    if (!mcpName.trim() || !mcpCommand.trim()) return
    await api.post('/api/mcp/servers', { name: mcpName, command: mcpCommand })
    setMcpName('')
    setMcpCommand('')
    load()
  }

  return (
    <div className="skills-page">
      <section className="panel">
        <h2>Skills</h2>
        <p className="hint">
          mjane uses SKILL.md packages (same format as Claude/opencode skills). Install from any
          GitHub repo containing skill folders.
        </p>
        <div className="install-row">
          <input
            placeholder="https://github.com/owner/repo[/tree/branch/subdir]"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" onClick={() => void install()}>
            Install from GitHub
          </button>
        </div>
        {status && <p className="mono status">{status}</p>}
        <ul className="skill-list">
          {skills.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <span className="hint"> — {s.description}</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={() => void toggle(s)}
                />
                {s.enabled ? 'enabled' : 'disabled'}
              </label>
            </li>
          ))}
          {skills.length === 0 && <li className="hint">No skills installed yet.</li>}
        </ul>
      </section>

      <section className="panel">
        <h2>MCP servers</h2>
        <p className="hint">mjane can call tools exposed by external MCP servers (stdio).</p>
        <div className="install-row">
          <input placeholder="name" value={mcpName} onChange={(e) => setMcpName(e.target.value)} />
          <input
            placeholder="command + args e.g. npx -y @modelcontextprotocol/server-filesystem /tmp"
            value={mcpCommand}
            onChange={(e) => setMcpCommand(e.target.value)}
            size={50}
          />
          <button type="button" onClick={() => void addServer()}>
            Add
          </button>
        </div>
        <ul className="skill-list">
          {servers.map((server) => (
            <li key={server.id}>
              <div>
                <strong>{server.name}</strong>
                <span className="hint mono"> — {server.command} {server.args}</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={() =>
                    void api.patch(`/api/mcp/servers/${server.id}`, { enabled: !server.enabled }).then(load)
                  }
                />
                {server.enabled ? 'enabled' : 'off'}
              </label>
              <button
                type="button"
                onClick={() =>
                  void api
                    .post<{ ok: boolean; tools?: { name: string }[]; error?: string }>(
                      `/api/mcp/servers/${server.id}/probe`,
                    )
                    .then((r) =>
                      setStatus(r.ok ? `tools: ${r.tools?.map((t) => t.name).join(', ')}` : `probe failed: ${r.error}`),
                    )
                    .catch(() => undefined)
                }
              >
                probe
              </button>
            </li>
          ))}
          {servers.length === 0 && <li className="hint">No MCP servers configured.</li>}
        </ul>
      </section>
    </div>
  )
}
