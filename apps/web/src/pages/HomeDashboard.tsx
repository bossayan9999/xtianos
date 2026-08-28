import { Fragment, useEffect, useRef, useState, useCallback } from 'react'

import { artifactUrl } from '../lib/auth'

interface Agent {
  id: number
  name: string
  displayName: string
  description: string
  model: string | null
  providerId: number | null
  hasKey: boolean
  color: string
  icon: string
  status: string
  isGeneral: boolean
}

interface TunnelMessage {
  id: string
  from: string
  to: string
  type: string
  content: string
  timestamp: string
  read: boolean
}

interface PipelineRun {
  id: number
  conversationId: number
  startedAt: number
  finishedAt: number | null
  prompt: string
  provider: string
  model: string
  output: string
  status: 'running' | 'done' | 'error'
}

interface PipelineStep {
  id: number
  runId: number
  conversationId: number
  ts: number
  stage: string
  kind: string
  label: string
  detail: string
  tool?: string | null
  artifactId?: number | null
  mime?: string | null
  filename?: string | null
  running?: boolean
}

function kindIcon(kind: string): string {
  switch (kind) {
    case 'goal': return '🎯'
    case 'tool-start': return '⚙️'
    case 'delegate': return '🤝'
    case 'tool-end': return '✓'
    case 'artifact': return '🖼️'
    case 'message': return '📝'
    case 'error': return '⚠️'
    case 'run-end': return '⏹️'
    default: return '·'
  }
}

const API = '/api'

interface DashboardProps {
  compact?: boolean
}

export function HomeDashboard({ compact = false }: DashboardProps) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [messages, setMessages] = useState<TunnelMessage[]>([])
  const [spinAngle, setSpinAngle] = useState(0)
  const [liveText, setLiveText] = useState('idle')
  const [runs, setRuns] = useState<PipelineRun[]>([])
  const [steps, setSteps] = useState<PipelineStep[]>([])
  const [flowStamp, setFlowStamp] = useState(0)
  const lastMsgIds = useRef<Set<string>>(new Set())

  // Load agents + refresh status
  const loadAgents = useCallback(() => {
    fetch(`${API}/agents`).then((r) => r.json()).then(setAgents).catch(() => {})
  }, [])

  // Load tunnel messages
  const loadMessages = useCallback(() => {
    fetch(`${API}/tunnel/messages?agent=broadcast`).then((r) => r.json()).then(setMessages).catch(() => {})
  }, [])

  useEffect(() => {
    loadAgents()
    loadMessages()
    const id = setInterval(() => {
      loadAgents()
      loadMessages()
    }, 2000)
    return () => clearInterval(id)
  }, [loadAgents, loadMessages])

  // Live data-flow snapshots (recorded at run time by the API)
  const loadPipeline = useCallback(() => {
    fetch(`${API}/chat/pipeline`)
      .then((r) => r.json())
      .then((p) => {
        setRuns(Array.isArray(p.runs) ? p.runs : [])
        setSteps(Array.isArray(p.steps) ? p.steps : [])
        setFlowStamp((s) => s + 1)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadPipeline()
    const id = setInterval(loadPipeline, 1000)
    return () => clearInterval(id)
  }, [loadPipeline])

  // Slow orbital rotation
  useEffect(() => {
    const id = setInterval(() => setSpinAngle((a) => (a + 0.15) % 360), 50)
    return () => clearInterval(id)
  }, [])

  // Live activity line
  useEffect(() => {
    const working = agents.find((a) => a.status === 'working')
    if (working) {
      setLiveText(`${working.icon} ${working.displayName} is working…`)
    } else {
      setLiveText('all agents idle · awaiting delegation')
    }
  }, [agents])

  // Detect new messages
  useEffect(() => {
    for (const m of messages) {
      if (!lastMsgIds.current.has(m.id)) {
        lastMsgIds.current.add(m.id)
      }
    }
  }, [messages])

  const general = agents.find((a) => a.isGeneral)
  const subs = agents.filter((a) => !a.isGeneral)
  const working = subs.filter((a) => a.status === 'working')

  const orbitCenter = { x: 190, y: 190 }
  const orbitR = 140

  const getPos = (agent: Agent, idx: number): { x: number; y: number } => {
    if (agent.isGeneral) return orbitCenter
    const base = (idx * 72) * Math.PI / 180
    const anim = base + (spinAngle * Math.PI) / 180
    return {
      x: orbitCenter.x + Math.cos(anim) * orbitR,
      y: orbitCenter.y + Math.sin(anim) * orbitR,
    }
  }

  // ── Live data-flow derived state ──
  const run = runs[0] ?? null
  const runSteps = run ? steps.filter((s) => s.runId === run.id) : []
  const flowRunning = (run?.status ?? '') === 'running'
  const toolSteps = runSteps.filter((s) => s.kind === 'tool-start' || s.kind === 'delegate')
  const uniqueTools = [
    ...new Map(toolSteps.map((s) => [s.tool ?? s.label, s])).values(),
  ].slice(-4)
  const lastTool = uniqueTools[uniqueTools.length - 1] ?? null
  const artifactStep = [...runSteps].reverse().find((s) => s.kind === 'artifact') ?? null
  const outputIsImage =
    Boolean(artifactStep) && /^image\//.test(artifactStep?.mime ?? '')
  const lastMessage =
    [...runSteps].reverse().find((s) => s.kind === 'message') ?? null
  const flowTime = (ts: number): string => new Date(ts).toLocaleTimeString()

  return (
    <div className="dash">
      {!compact && (
      <div className="dash-header">
        <h2>Live Mission Control</h2>
        <span className={`dash-live ${working.length > 0 ? 'live-working' : ''}`}>
          <i className="dash-pulse-dot" /> {liveText}
        </span>
      </div>
      )}

      <div className="dash-layout">
        {/* ── Left panel: constellation + workflow ── */}
        <div className="dash-left panel">
          <h3 className="dash-panel-title">Agent Constellation</h3>

          {/* Orbital SVG */}
          <div className="dash-orbital">
            <svg width="380" height="380" viewBox="0 0 380 380">
              <circle cx={orbitCenter.x} cy={orbitCenter.y} r={orbitR} fill="none" stroke="#ffffff12" strokeWidth="1" strokeDasharray="4 8" />

              {/* Connection lines + data particles */}
              {subs.map((agent, idx) => {
                const pos = getPos(agent, idx)
                const isWorking = agent.status === 'working'
                return (
                  <g key={`l-${agent.id}`}>
                    <line
                      x1={orbitCenter.x} y1={orbitCenter.y} x2={pos.x} y2={pos.y}
                      stroke={isWorking ? agent.color : '#ffffff15'}
                      strokeWidth={isWorking ? 2 : 1}
                      strokeDasharray={isWorking ? 'none' : '4 4'}
                    />
                    {isWorking && (
                      <>
                        <circle r="3.5" fill={agent.color}>
                          <animateMotion dur="1.2s" repeatCount="indefinite"
                            path={`M${orbitCenter.x},${orbitCenter.y} L${pos.x},${pos.y}`} />
                        </circle>
                        <circle r="2" fill={agent.color} opacity="0.6">
                          <animateMotion dur="1.2s" repeatCount="indefinite" begin="0.4s"
                            path={`M${orbitCenter.x},${orbitCenter.y} L${pos.x},${pos.y}`} />
                        </circle>
                      </>
                    )}
                  </g>
                )
              })}

              {/* General node */}
              {general && (
                <g onClick={() => {}} style={{ cursor: 'pointer' }}>
                  <circle cx={orbitCenter.x} cy={orbitCenter.y} r="30" fill="#0a0d13" stroke={general.color} strokeWidth="2"
                    className={`dash-ring status--${general.status}`} />
                  <text x={orbitCenter.x} y={orbitCenter.y - 2} textAnchor="middle" dominantBaseline="middle" fontSize="18">{general.icon}</text>
                  <text x={orbitCenter.x} y={orbitCenter.y + 18} textAnchor="middle" fontSize="10" fill={general.color} fontWeight="600">{general.displayName}</text>
                </g>
              )}

              {/* Sub-agent nodes */}
              {subs.map((agent, idx) => {
                const pos = getPos(agent, idx)
                return (
                  <g key={`a-${agent.id}`} style={{ cursor: 'pointer' }}>
                    <circle cx={pos.x} cy={pos.y} r="22" fill="#0a0d13" stroke={agent.color} strokeWidth="1.5"
                      className={`dash-ring status--${agent.status}`} />
                    <text x={pos.x} y={pos.y - 1} textAnchor="middle" dominantBaseline="middle" fontSize="14">{agent.icon}</text>
                    <text x={pos.x} y={pos.y + 15} textAnchor="middle" fontSize="8.5" fill={agent.color}>{agent.displayName}</text>
                    <text x={pos.x} y={pos.y + 25} textAnchor="middle" fontSize="7" fill="#77839a" style={{ textTransform: 'uppercase' }}>{agent.status}</text>
                  </g>
                )
              })}
            </svg>
          </div>

          {/* Workflow pipeline */}
          <h3 className="dash-panel-title dash-pipeline-title">
            Live Data Flow
            {run && (
              <span className="flow-run-meta">
                #{run.id} · {run.model}
              </span>
            )}
            <span className={`flow-badge ${flowRunning ? 'on' : ''}`}>
              {flowRunning ? 'LIVE' : (run?.status ?? '')}
            </span>
          </h3>
          <div className="dash-pipeline flow">
            <div className="flow-node flow-node--goal">
              <span className="flow-node-label">🎯 Goal</span>
              {run ? (
                <span className="flow-node-detail">{run.prompt}</span>
              ) : (
                <span className="flow-node-detail hint">waiting for a run — ask mjane anything</span>
              )}
            </div>
            <span className="dash-wire">
              <i
                key={flowStamp}
                className="dash-flow-particle"
                style={{
                  animationDuration: flowRunning ? '0.7s' : '1.8s',
                  backgroundColor: flowRunning ? '#ffd479' : '#46587a',
                }}
              />
            </span>
            {uniqueTools.length === 0 && (
              <>
                <div className="flow-node flow-node--act"><span className="flow-node-label">⚙️ Act</span></div>
                <span className="dash-wire">
                  <i key={flowStamp} className="dash-flow-particle" style={{ animationDuration: '1.8s', backgroundColor: '#46587a' }} />
                </span>
              </>
            )}
            {uniqueTools.map((step) => (
              <Fragment key={step.id}>
                <div className={`flow-node flow-node--act ${step === lastTool && flowRunning ? 'active' : ''}`}>
                  <span className="flow-node-label">
                    {step.kind === 'delegate' ? '🤝' : '⚙️'} {step.label}
                  </span>
                  <span className="flow-node-detail">{step.detail}</span>
                </div>
                <span className="dash-wire">
                  <i
                    key={`${flowStamp}-${step.id}`}
                    className="dash-flow-particle"
                    style={{
                      animationDuration: step === lastTool && flowRunning ? '0.7s' : '1.8s',
                      backgroundColor: step === lastTool && flowRunning ? '#5aa7ff' : '#46587a',
                    }}
                  />
                </span>
              </Fragment>
            ))}
            <div className={`flow-node flow-node--output ${outputIsImage ? 'has-image' : ''}`}>
              <span className="flow-node-label">🖼️ Output</span>
              {outputIsImage && artifactStep ? (
                <a
                  className="flow-thumb-link"
                  href={artifactUrl(artifactStep.artifactId)}
                  target="_blank"
                  rel="noreferrer"
                  title="open full size"
                >
                  <img
                    className="flow-thumb"
                    src={artifactUrl(artifactStep.artifactId)}
                    alt={artifactStep.filename ?? 'output image'}
                  />
                  <span className="flow-thumb-meta">{artifactStep.filename}</span>
                </a>
              ) : lastMessage ? (
                <span className="flow-node-detail">{lastMessage.detail}</span>
              ) : run && !flowRunning ? (
                <span className="flow-node-detail hint">{run.status}</span>
              ) : (
                <span className="flow-node-detail hint">data lands here…</span>
              )}
            </div>
          </div>

          {/* Live step tape */}
          <div className="flow-tape">
            {runSteps.length === 0 && (
              <p className="hint">No active run. Data flowing through mjane's tools will appear here live.</p>
            )}
            {runSteps
              .slice(-18)
              .reverse()
              .map((s) => (
                <div key={s.id} className="flow-tape-row">
                  <span className="flow-tape-kind">{kindIcon(s.kind)}</span>
                  <span className="flow-tape-main">
                    <span className="flow-tape-label">
                      {s.label}
                      {s.running && <i className="mterm-spin" />}
                    </span>
                    <span className="flow-tape-detail">{s.detail}</span>
                  </span>
                  <span className="flow-tape-time">{flowTime(s.ts)}</span>
                </div>
              ))}
          </div>

          {/* Workflow activity log */}
          <h3 className="dash-panel-title dash-pipeline-title">Agent Feed</h3>
          <div className="dash-feed">
            {subs.map((agent) => (
              <div key={agent.id} className="dash-feed-row">
                <span className="dash-feed-icon" style={{ color: agent.color }}>{agent.icon}</span>
                <span className="dash-feed-name">{agent.displayName}</span>
                <span className={`dash-feed-status status-text--${agent.status}`}>
                  {agent.status === 'idle' ? 'idle' : agent.status === 'working' ? 'working…' : 'error'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right panel: tunnel messages + agent status (full-only) ── */}
        {!compact && (
        <div className="dash-right">
          <div className="panel">
            <h3 className="dash-panel-title">Inter-Agent Messages</h3>
            <div className="dash-msg-list">
              {messages.length === 0 && <p className="hint">No inter-agent messages yet.</p>}
              {messages.slice(-30).reverse().map((m) => (
                <div key={m.id} className="dash-msg">
                  <div className="dash-msg-head">
                    <span className="dash-msg-from">{m.from} → {m.to}</span>
                    <span className="dash-msg-time">{new Date(m.timestamp).toLocaleTimeString()}</span>
                    <span className={`dash-msg-type ${m.type}`}>{m.type}</span>
                  </div>
                  <div className="dash-msg-body">{m.content.slice(0, 160)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3 className="dash-panel-title">Agent Model Config</h3>
            <div className="dash-model-list">
              {agents.map((a) => (
                <div key={a.id} className="dash-model-row">
                  <span className="dash-model-icon" style={{ color: a.color }}>{a.icon}</span>
                  <span className="dash-model-name">{a.displayName}</span>
                  <code className="dash-model-spec">
                    {a.model ? (a.providerId ? `${a.providerId}:${a.model}` : a.model) : 'default'}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
