import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../lib/api'

interface AuditRow {
  id: number
  action: string
  detail: string
  createdAt: string
}

interface TermTab {
  id: string
  name: string
  lines: string[]
  running: boolean
}

function makeId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

const AGENT_ACTIONS = new Set([
  'tool:shell_exec',
  'tool:brain_write',
  'tool:workspace_write',
  'tool:web_search',
  'tool:web_fetch',
  'tool:memory_search',
  'tool:brain_read',
  'tool:brain_search',
  'agent:delegate',
  'task_create',
  'tunnel:send',
])

/**
 * Terminal panel for Mission Control.
 *
 * - "Agent Feed" tab: shows what mjane + her sub-agents are doing live
 *   (every shell_exec / write / search is audit-logged) — the "code mjane is doing".
 * - "Session" tabs: user creates real terminals that run on the desktop host
 *   (via /api/exec). Supports multiple tabs.
 */
export function MissionTerminal() {
  const [tabs, setTabs] = useState<TermTab[]>(() => [
    { id: '__agent', name: '👁 Agent Feed', lines: [], running: false },
  ])
  const [activeId, setActiveId] = useState('__agent')
  const [command, setCommand] = useState('')
  const [modelSpec, setModelSpec] = useState<string | null>(null)

  const feedRef = useRef<HTMLDivElement>(null)
  const seenAudit = useRef<Set<number>>(new Set())

  // ── mjane's live activity feed ──
  const pollFeed = useCallback(async () => {
    try {
      const rows = await api.get<AuditRow[]>('/api/audit')
      const fresh = rows
        .filter((r) => AGENT_ACTIONS.has(r.action) && !seenAudit.current.has(r.id))
        .reverse()
      if (fresh.length === 0) return

      for (const row of fresh) seenAudit.current.add(row.id)
      const lines = fresh.map((r) => {
        const time = new Date(r.createdAt).toLocaleTimeString()
        const detail = r.detail.length > 160 ? `${r.detail.slice(0, 160)}…` : r.detail
        return `[${time}] ${prettifyAction(r.action)}\n${detail}`
      })
      setTabs((prev) =>
        prev.map((t) => (t.id === '__agent' ? { ...t, lines: [...t.lines, ...lines].slice(-200) } : t)),
      )
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    pollFeed()
    const id = setInterval(pollFeed, 2500)
    return () => clearInterval(id)
  }, [pollFeed])

  // Auto-scroll feed
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [tabs])

  // ── user terminals (connect to desktop via /api/exec) ──
  const addTab = (): void => {
    const id = makeId()
    setTabs((prev) => [
      ...prev,
      { id, name: `term-${prev.length}`, lines: ['ready. type a command and press Enter'], running: false },
    ])
    setActiveId(id)
  }

  const closeTab = (id: string): void => {
    if (id === '__agent') return
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? '__agent')
      return next
    })
  }

  const run = async (tabId: string): Promise<void> => {
    const cmd = command.trim()
    if (!cmd) return
    setCommand('')
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, lines: [...t.lines, `$ ${cmd}`], running: true } : t,
      ),
    )
    try {
      const r = await api.post<{ output: string; code: number }>('/api/exec', {
        command: cmd,
        confirmed: true,
      })
      const out = r.output || `(exit ${r.code})`
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, lines: [...t.lines, out], running: false } : t,
        ),
      )
    } catch (error: unknown) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, lines: [...t.lines, `BLOCKED ${error instanceof Error ? error.message : String(error)}`], running: false }
            : t,
        ),
      )
    }
  }

  const active = tabs.find((t) => t.id === activeId)

  return (
    <div className="mterm">
      <div className="mterm-bar">
        <div className="mterm-tabs">
          {tabs.map((t) => (
            <span
              key={t.id}
              className={`mterm-tab ${t.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(t.id)}
            >
              {t.name}
              {t.running && <i className="mterm-spin" />}
              {t.id !== '__agent' && (
                <button
                  type="button"
                  className="mterm-tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
        <button type="button" className="mterm-new" onClick={addTab}>
          + Terminal
        </button>
        <span className="mterm-hint">
          {activeId === '__agent'
            ? 'live view of what mjane + agents are doing (from audit log)'
            : 'runs on this desktop host'}
        </span>
      </div>

      <div ref={feedRef} className={`mterm-out ${activeId === '__agent' ? 'agent-feed' : ''}`}>
        {(active?.lines ?? []).join('\n') || (activeId === '__agent' ? 'watching mjane…' : 'ready.')}
      </div>

      <div className="mterm-input">
        <input
          placeholder={
            activeId === '__agent'
              ? 'switch to a terminal tab to run commands'
              : 'e.g. dir  |  gpustat  |  python app.py'
          }
          value={command}
          disabled={activeId === '__agent'}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && activeId !== '__agent') void run(activeId)
          }}
        />
        <button
          type="button"
          disabled={activeId === '__agent'}
          onClick={() => void run(activeId)}
        >
          Run
        </button>
      </div>
    </div>
  )
}

function prettifyAction(action: string): string {
  switch (action) {
    case 'tool:shell_exec':
      return '⚙ mjane ran:'
    case 'tool:brain_write':
      return '✍️ mjane wrote brain note:'
    case 'tool:workspace_write':
      return '📝 mjane wrote file:'
    case 'tool:web_search':
      return '🌐 mjane searched web:'
    case 'tool:web_fetch':
      return '📄 mjane fetched url:'
    case 'tool:memory_search':
      return '🧠 mjane recalled memory:'
    case 'tool:brain_read':
      return '📖 mjane read brain note:'
    case 'tool:brain_search':
      return '🔍 mjane searched brain:'
    case 'agent:delegate':
      return '🤝 mjane delegated:'
    case 'task_create':
      return '📋 mjane created task:'
    case 'tunnel:send':
      return '📨 mjane messaged agent:'
    default:
      return action
  }
}
