import { useEffect, useState } from 'react'
import { api, sseStream } from '../lib/api'
import type { ContainerInfo } from './types'

export function TerminalPage() {
  const [lines, setLines] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null)
  const [dockerOk, setDockerOk] = useState<boolean | null>(null)
  const [modelSpec, setModelSpec] = useState<string | null>(null)

  useEffect(() => {
    api.get<{ available: boolean }>('/api/docker/status').then((r) => setDockerOk(r.available)).catch(() => undefined)
    api.get<ContainerInfo[]>('/api/docker/containers').then(setContainers).catch(() => setContainers([]))
    api.get<{ defaultModel: string | null }>('/api/providers/default-model')
      .then((r) => setModelSpec(r.defaultModel))
      .catch(() => undefined)
  }, [])

  const run = async (): Promise<void> => {
    const cmd = command.trim()
    if (!cmd) return
    setLines((prev) => [...prev, `$ ${cmd}`])
    setCommand('')
    if (cmd.startsWith('mjane ')) {
      const question = cmd.slice(6)
      let conversationId: number
      try {
        conversationId = (await api.post<{ id: number }>('/api/chat')).id
      } catch (error: unknown) {
        setLines((prev) => [...prev, `ERROR ${String(error)}`])
        return
      }
      await sseStream(
        `/api/chat/${conversationId}/stream`,
        { content: question, model: modelSpec },
        (_e, data) => {
          const step = data as { type: string; data: unknown }
          if (step.type === 'message') setLines((prev) => [...prev, String(step.data)])
          else if (step.type === 'tool-end')
            setLines((prev) => [...prev, `  ⚙ ${(step.data as { name: string }).name} done`])
          else if (step.type === 'error') setLines((prev) => [...prev, `⚠️ ${String(step.data)}`])
        },
      )
      return
    }
    try {
      const r = await api.post<{ output: string; code: number }>('/api/exec', {
        command: cmd,
        confirmed: true,
      })
      setLines((prev) => [...prev, r.output || `(exit ${r.code})`])
    } catch (error: unknown) {
      setLines((prev) => [...prev, `BLOCKED ${error instanceof Error ? error.message : String(error)}`])
    }
  }

  return (
    <div className="terminal-page">
      <section className="panel">
        <h2>Terminal</h2>
        <p className="hint">
          Shell on the Kali host — every run is audit-logged; destructive patterns are blocked.
          Prefix with <code>mjane </code> to ask the agent instead.
        </p>
        <pre className="terminal-out">{lines.join('\n') || 'ready.'}</pre>
        <div className="install-row">
          <input
            placeholder="uname -a   |   mjane what services are unhealthy?"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
            }}
          />
          <button type="button" onClick={() => void run()}>
            Run
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Docker {dockerOk === false ? '(socket unavailable)' : ''}</h2>
        <ul className="skill-list">
          {(containers ?? []).map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>
              <span className="hint mono"> {c.image}</span>
              <span className={`chip ${c.state === 'running' ? 'chip--sev-info' : 'chip--sev-warning'}`}>
                {c.status}
              </span>
              {c.state === 'running' ? (
                <button type="button" onClick={() => void api.post(`/api/docker/containers/${c.id}/stop`).then(() =>
                  api.get<ContainerInfo[]>('/api/docker/containers').then(setContainers),
                )}>
                  stop
                </button>
              ) : (
                <button type="button" onClick={() => void api.post(`/api/docker/containers/${c.id}/start`).then(() =>
                  api.get<ContainerInfo[]>('/api/docker/containers').then(setContainers),
                )}>
                  start
                </button>
              )}
            </li>
          ))}
          {(containers ?? []).length === 0 && (
            <li className="hint">No containers visible (is the docker socket accessible?).</li>
          )}
        </ul>
      </section>
    </div>
  )
}
