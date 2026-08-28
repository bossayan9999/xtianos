import { useEffect, useRef, useState, useCallback } from 'react'
import { ModelPicker } from '../components/ModelPicker'

interface Agent {
  id: number
  name: string
  displayName: string
  description: string
  personality: string
  systemPromptAdd: string
  toolsAllowed: string
  providerId: number | null
  model: string | null
  hasKey: boolean
  color: string
  icon: string
  orbitRadius: number
  orbitAngle: number
  status: string
  isGeneral: boolean
  enabled: boolean
}

interface Provider {
  id: number
  label: string
  kind: string
  baseUrl: string
  hasKey: boolean
}

const API = '/api'

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [selected, setSelected] = useState<Agent | null>(null)
  const [modelSpec, setModelSpec] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [spinAngle, setSpinAngle] = useState(0)
  const canvasRef = useRef<HTMLDivElement>(null)

  const loadAgents = useCallback(() => {
    fetch(`${API}/agents`).then((r) => r.json()).then((data: Agent[]) => {
      setAgents(data)
      // Keep selected in sync with refreshed data
      setSelected((prev) => {
        if (!prev) return null
        const fresh = data.find((a) => a.id === prev.id)
        return fresh ?? prev
      })
    }).catch(() => {})
  }, [])

  useEffect(() => {
    loadAgents()
    fetch(`${API}/providers`).then((r) => r.json()).then(setProviders).catch(() => {})
  }, [loadAgents])

  // Slow orbital rotation
  useEffect(() => {
    const id = setInterval(() => {
      setSpinAngle((a) => (a + 0.15) % 360)
    }, 50)
    return () => clearInterval(id)
  }, [])

  // Refetch agents to get live status
  useEffect(() => {
    const id = setInterval(loadAgents, 3000)
    return () => clearInterval(id)
  }, [loadAgents])

  // Sync modelSpec when selected agent is refreshed from the server
  useEffect(() => {
    if (!selected) return
    if (selected.model) {
      setModelSpec(selected.providerId ? `${selected.providerId}:${selected.model}` : selected.model)
    } else {
      setModelSpec(null)
    }
  }, [selected?.id, selected?.model, selected?.providerId])

  const openAgent = (agent: Agent): void => {
    setSelected(agent)
    // Reconstruct modelSpec: "providerId:model" or just "model" for starter catalog entries
    if (agent.model) {
      setModelSpec(agent.providerId ? `${agent.providerId}:${agent.model}` : agent.model)
    } else {
      setModelSpec(null)
    }
    setApiKey('')
  }

  const saveModel = async (spec: string | null = modelSpec): Promise<void> => {
    if (!selected) return
    setSaving(true)
    try {
      // ModelPicker returns "providerId:model" or just "model"
      // Split into providerId (number) and model (string) for the backend
      let providerId: number | null = null
      let model: string | null = null
      if (spec && spec.includes(':')) {
        const colonIdx = spec.indexOf(':')
        const pid = Number.parseInt(spec.slice(0, colonIdx), 10)
        if (!Number.isNaN(pid)) {
          providerId = pid
          model = spec.slice(colonIdx + 1)
        } else {
          model = spec
        }
      } else {
        model = spec
      }
      const res = await fetch(`${API}/agents/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, providerId }),
      })
      const updated = await res.json()
      // Sync selected with the fresh data from the server
      setSelected(updated)
      loadAgents()
    } finally {
      setSaving(false)
    }
  }

  // Auto-save whenever a model is chosen (no separate Save click needed)
  const changeModel = (spec: string): void => {
    setModelSpec(spec)
    void saveModel(spec)
  }

  const saveKey = async (): Promise<void> => {
    if (!selected || !apiKey) return
    setSaving(true)
    try {
      await fetch(`${API}/agents/${selected.id}/key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      })
      setApiKey('')
      loadAgents()
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (agent: Agent): Promise<void> => {
    await fetch(`${API}/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !agent.enabled }),
    })
    loadAgents()
  }

  const orbitCenter = { x: 400, y: 300 }

  const getAgentPos = (agent: Agent, idx: number): { x: number; y: number } => {
    if (agent.isGeneral) return orbitCenter
    const baseAngle = (agent.orbitAngle * Math.PI) / 180
    const animAngle = baseAngle + (spinAngle * Math.PI) / 180
    return {
      x: orbitCenter.x + Math.cos(animAngle) * agent.orbitRadius,
      y: orbitCenter.y + Math.sin(animAngle) * agent.orbitRadius,
    }
  }

  const general = agents.find((a) => a.isGeneral)
  const subs = agents.filter((a) => !a.isGeneral)

  return (
    <div className="agents-page">
      <div className="agents-header">
        <h2>Agent Constellation</h2>
        <span className="hint">mjane delegates tasks to specialized agents automatically</span>
      </div>

      <div className="agents-layout">
        {/* Orbital visualization */}
        <div className="orbital-container" ref={canvasRef}>
          <svg width="800" height="600" className="orbital-svg">
            {/* Orbit ring */}
            {subs.length > 0 && (
              <circle
                cx={orbitCenter.x}
                cy={orbitCenter.y}
                r={subs[0]?.orbitRadius ?? 140}
                fill="none"
                stroke="#ffffff10"
                strokeWidth="1"
                strokeDasharray="4 8"
              />
            )}

            {/* Connection lines */}
            {subs.map((agent, i) => {
              const pos = getAgentPos(agent, i + 1)
              const isWorking = agent.status === 'working'
              return (
                <g key={`line-${agent.id}`}>
                  <line
                    x1={orbitCenter.x}
                    y1={orbitCenter.y}
                    x2={pos.x}
                    y2={pos.y}
                    stroke={isWorking ? agent.color : '#ffffff15'}
                    strokeWidth={isWorking ? 2 : 1}
                    strokeDasharray={isWorking ? 'none' : '4 4'}
                    className={isWorking ? 'orbital-line active' : 'orbital-line'}
                  />
                  {isWorking && (
                    <>
                      <circle r="3" fill={agent.color} opacity="0.9">
                        <animateMotion
                          dur="1.5s"
                          repeatCount="indefinite"
                          path={`M${orbitCenter.x},${orbitCenter.y} L${pos.x},${pos.y}`}
                        />
                      </circle>
                      <circle r="2" fill={agent.color} opacity="0.5">
                        <animateMotion
                          dur="1.5s"
                          repeatCount="indefinite"
                          begin="0.5s"
                          path={`M${orbitCenter.x},${orbitCenter.y} L${pos.x},${pos.y}`}
                        />
                      </circle>
                    </>
                  )}
                </g>
              )
            })}

            {/* General node (mjane) */}
            {general && (
              <g
                className="orbital-node general"
                onClick={() => openAgent(general)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={orbitCenter.x}
                  cy={orbitCenter.y}
                  r="36"
                  fill="#0a0d13"
                  stroke={general.color}
                  strokeWidth="2"
                  className={`agent-ring status--${general.status}`}
                />
                <circle
                  cx={orbitCenter.x}
                  cy={orbitCenter.y}
                  r="40"
                  fill="none"
                  stroke={general.color}
                  strokeWidth="1"
                  opacity="0.3"
                  className="agent-glow"
                />
                <text
                  x={orbitCenter.x}
                  y={orbitCenter.y - 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="22"
                  className="agent-icon"
                >
                  {general.icon}
                </text>
                <text
                  x={orbitCenter.x}
                  y={orbitCenter.y + 20}
                  textAnchor="middle"
                  fontSize="11"
                  fill={general.color}
                  fontWeight="600"
                  className="agent-label"
                >
                  {general.displayName}
                </text>
              </g>
            )}

            {/* Sub-agent nodes */}
            {subs.map((agent, i) => {
              const pos = getAgentPos(agent, i + 1)
              return (
                <g
                  key={agent.id}
                  className="orbital-node sub"
                  onClick={() => openAgent(agent)}
                  style={{ cursor: 'pointer' }}
                >
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r="28"
                    fill="#0a0d13"
                    stroke={agent.color}
                    strokeWidth="1.5"
                    className={`agent-ring status--${agent.status}`}
                  />
                  <text
                    x={pos.x}
                    y={pos.y - 1}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="18"
                    className="agent-icon"
                  >
                    {agent.icon}
                  </text>
                  <text
                    x={pos.x}
                    y={pos.y + 18}
                    textAnchor="middle"
                    fontSize="10"
                    fill={agent.color}
                    className="agent-label"
                  >
                    {agent.displayName}
                  </text>
                  <text
                    x={pos.x}
                    y={pos.y + 30}
                    textAnchor="middle"
                    fontSize="8"
                    fill="#77839a"
                    className="agent-status-text"
                  >
                    {agent.status}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>

        {/* Agent list + config */}
        <div className="agents-sidebar">
          <div className="agents-list">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className={`agent-card ${selected?.id === agent.id ? 'selected' : ''} status--${agent.status}`}
                onClick={() => openAgent(agent)}
              >
                <span className="agent-card-icon" style={{ color: agent.color }}>{agent.icon}</span>
                <div className="agent-card-info">
                  <span className="agent-card-name">{agent.displayName}</span>
                  <span className="agent-card-role">{agent.description.slice(0, 50)}</span>
                </div>
                <span className={`agent-card-status status-dot--${agent.status}`} />
              </div>
            ))}
          </div>

          {selected && (
            <div className="agent-config panel">
              <h3 style={{ color: selected.color }}>{selected.icon} {selected.displayName}</h3>
              <p className="hint">{selected.description}</p>

              <div className="agent-config-field">
                <label>Model</label>
                <div className="agent-config-row">
                  <ModelPicker value={modelSpec} onChange={changeModel} />
                  <span className="hint">{saving ? 'saving…' : 'auto-saved ✓'}</span>
                </div>
                <span className="hint">
                  {selected.model
                    ? `Current: ${selected.providerId ? `${selected.providerId}:` : ''}${selected.model}`
                    : 'Using global default'}
                </span>
              </div>

              <div className="agent-config-field">
                <label>API Key</label>
                <div className="agent-config-row">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={selected.hasKey ? '•••••••• (key set)' : 'Paste API key'}
                  />
                  <button type="button" onClick={() => void saveKey()} disabled={saving || !apiKey}>
                    Set Key
                  </button>
                </div>
                <span className="hint">
                  {selected.hasKey ? 'Key configured (agent-specific)' : 'Will use provider default key'}
                </span>
              </div>

              <div className="agent-config-field">
                <label>Allowed Tools</label>
                <code className="agent-tools-list">{selected.toolsAllowed}</code>
              </div>

              <div className="agent-config-field">
                <label>Status</label>
                <span className={`agent-status-badge status--${selected.status}`}>{selected.status}</span>
              </div>

              <div className="agent-config-actions">
                <button
                  type="button"
                  onClick={() => void toggleEnabled(selected)}
                >
                  {selected.enabled ? 'Disable' : 'Enable'}
                </button>
                {!selected.isGeneral && (
                  <button
                    type="button"
                    className="danger"
                    onClick={async () => {
                      await fetch(`${API}/agents/${selected.id}`, { method: 'DELETE' })
                      setSelected(null)
                      loadAgents()
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
