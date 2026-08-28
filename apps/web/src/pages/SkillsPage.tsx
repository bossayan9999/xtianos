import { useEffect, useState } from 'react'
import type { McpServerConfig, McpResourceInfo, McpPromptInfo, SkillManifest } from '@xtiand/shared'

import { api } from '../lib/api'
import { McpServerPicker, type McpServerOption } from '../components/McpServerPicker'
import { SkillRepoPicker } from '../components/SkillRepoPicker'

interface ProbeResult {
  ok?: boolean
  error?: string
  tools?: { name: string; description?: string }[]
  resources?: McpResourceInfo[]
  prompts?: McpPromptInfo[]
  sampleResource?: string
  transport?: string
}

export function SkillsPage() {
  const [skills, setSkills] = useState<(SkillManifest & { id: number })[]>([])
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState('')
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [probes, setProbes] = useState<Record<number, ProbeResult>>({})

  // add-server form
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http' | 'sse'>('stdio')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpHeaders, setMcpHeaders] = useState('{}')

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
    const urlValid = mcpTransport !== 'stdio' && mcpUrl.trim().length > 0
    const stdioValid = mcpTransport === 'stdio' && mcpCommand.trim().length > 0
    if (!mcpName.trim() || (!urlValid && !stdioValid)) return
    await api.post('/api/mcp/servers', {
      name: mcpName,
      transport: mcpTransport,
      command: mcpCommand,
      args: mcpArgs,
      url: mcpUrl,
      headersJson: mcpHeaders,
      enabled: true,
    })
    setMcpName('')
    setMcpCommand('')
    setMcpArgs('')
    setMcpUrl('')
    setMcpHeaders('{}')
    load()
  }

  const applyServerPreset = (option: McpServerOption): void => {
    setMcpName(option.name)
    setMcpTransport(option.transport)
    setMcpCommand(option.command ?? '')
    setMcpArgs(option.args ?? '')
    setMcpUrl(option.url ?? '')
    if (option.url) setMcpHeaders('{}')
  }

  const probe = async (id: number): Promise<void> => {
    setProbes((p) => ({ ...p, [id]: {} }))
    try {
      const r = await api.post<ProbeResult>(`/api/mcp/servers/${id}/probe`)
      setProbes((p) => ({ ...p, [id]: r }))
      setStatus(
        r.ok
          ? `ok (${r.transport}): ${r.tools?.length ?? 0} tools, ${r.resources?.length ?? 0} resources, ${r.prompts?.length ?? 0} prompts`
          : `probe failed: ${r.error}`,
      )
    } catch (error: unknown) {
      setProbes((p) => ({ ...p, [id]: { error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const readResource = async (id: number, uri: string): Promise<void> => {
    try {
      const r = await api.post<{ text: string }>(`/api/mcp/servers/${id}/read-resource`, { uri })
      setStatus(`resource ${uri}:\n${r.text.slice(0, 1200)}`)
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const getPrompt = async (id: number, name: string): Promise<void> => {
    try {
      const r = await api.post<{ text: string }>(`/api/mcp/servers/${id}/get-prompt`, { name, argsJson: '{}' })
      setStatus(`prompt ${name}:\n${r.text.slice(0, 1200)}`)
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const syncConfig = async (): Promise<void> => {
    setStatus('syncing mcp.json…')
    try {
      const r = await api.post<{ results: { root: string; added: number; updated: number }[] }>('/api/mcp/sync-config')
      const parts = r.results
        .filter((x) => x.added > 0 || x.updated > 0)
        .map((x) => `+${x.added}/${x.updated} in ${x.root}`)
      setStatus(parts.length > 0 ? `mcp.json synced: ${parts.join(', ')}` : 'mcp.json: no servers defined')
      load()
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
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
          <div className="model-picker mcp-picker skill-repo-picker">
            <SkillRepoPicker value={url} onChange={setUrl} onTyped={setUrl} />
          </div>
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
        <p className="hint">
          mjane can call tools exposed by external MCP servers. Supports stdio (local) and
          Streamable HTTP (remote). Servers can also be declared in <span className="mono">mcp.json</span>.
        </p>

        <div className="mcp-add-form">
          <McpServerPicker
            value={mcpName}
            onTyped={(v) => setMcpName(v)}
            onChange={applyServerPreset}
          />
          <select value={mcpTransport} onChange={(e) => setMcpTransport(e.target.value as 'stdio' | 'http' | 'sse')}>
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
          {mcpTransport === 'stdio' ? (
            <>
              <input
                placeholder="command e.g. npx -y @modelcontextprotocol/server-filesystem /tmp"
                value={mcpCommand}
                onChange={(e) => setMcpCommand(e.target.value)}
                size={40}
              />
              <input
                placeholder="args (space separated)"
                value={mcpArgs}
                onChange={(e) => setMcpArgs(e.target.value)}
                size={24}
              />
            </>
          ) : (
            <>
              <input
                placeholder="URL e.g. https://mcp.example.com/mcp"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                size={40}
              />
              <input
                placeholder='headers JSON e.g. {"Authorization":"Bearer x"}'
                value={mcpHeaders}
                onChange={(e) => setMcpHeaders(e.target.value)}
                size={36}
              />
            </>
          )}
          <button type="button" onClick={() => void addServer()}>
            Add
          </button>
        </div>

        <div className="install-row">
          <button type="button" onClick={() => void syncConfig()}>
            Sync mcp.json
          </button>
          <span className="hint">loads servers from <span className="mono">mcp.json</span> in the workspace</span>
        </div>

        <ul className="skill-list">
          {servers.map((server) => {
            const p = probes[server.id]
            return (
              <li key={server.id} className="mcp-server">
                <div>
                  <strong>{server.name}</strong>
                  <span className="hint mono">
                    {' '}
                    — {server.transport ?? 'stdio'}
                    {server.transport === 'stdio'
                      ? ` ${server.command} ${server.args}`
                      : ` ${server.url}`}
                  </span>
                </div>
                <div className="mcp-actions">
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
                  <button type="button" onClick={() => void probe(server.id)}>
                    probe
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .del(`/api/mcp/servers/${server.id}`)
                        .then(load)
                        .catch(() => undefined)
                    }
                  >
                    delete
                  </button>
                </div>

                {p && p.error && <p className="mono status error">{p.error}</p>}
                {p && p.ok && (
                  <div className="mcp-probe">
                    <div className="mcp-col">
                      <h4>Tools ({p.tools?.length ?? 0})</h4>
                      <ul>
                        {(p.tools ?? []).slice(0, 20).map((t) => (
                          <li key={t.name}>
                            <strong>{t.name}</strong>
                            <span className="hint"> — {t.description}</span>
                          </li>
                        ))}
                        {(p.tools?.length ?? 0) > 20 && <li className="hint">…{p.tools!.length - 20} more</li>}
                      </ul>
                    </div>
                    <div className="mcp-col">
                      <h4>Resources ({p.resources?.length ?? 0})</h4>
                      <ul>
                        {(p.resources ?? []).slice(0, 20).map((r) => (
                          <li key={r.uri}>
                            <button
                              type="button"
                              className="link-like"
                              onClick={() => void readResource(server.id, r.uri)}
                            >
                              {r.uri}
                            </button>
                            {r.name && <span className="hint"> — {r.name}</span>}
                          </li>
                        ))}
                        {(p.resources?.length ?? 0) > 20 && (
                          <li className="hint">…{(p.resources?.length ?? 0) - 20} more</li>
                        )}
                      </ul>
                    </div>
                    <div className="mcp-col">
                      <h4>Prompts ({p.prompts?.length ?? 0})</h4>
                      <ul>
                        {(p.prompts ?? []).slice(0, 20).map((pr) => (
                          <li key={pr.name}>
                            <button
                              type="button"
                              className="link-like"
                              onClick={() => void getPrompt(server.id, pr.name)}
                            >
                              {pr.name}
                            </button>
                            {pr.description && <span className="hint"> — {pr.description}</span>}
                          </li>
                        ))}
                        {(p.prompts?.length ?? 0) > 20 && (
                          <li className="hint">…{(p.prompts?.length ?? 0) - 20} more</li>
                        )}
                      </ul>
                    </div>
                  </div>
                )}
                {p && p.sampleResource !== undefined && p.sampleResource && (
                  <details>
                    <summary>sample resource</summary>
                    <pre className="mono sample-resource">{p.sampleResource.slice(0, 800)}</pre>
                  </details>
                )}
              </li>
            )
          })}
          {servers.length === 0 && <li className="hint">No MCP servers configured.</li>}
        </ul>
      </section>
    </div>
  )
}