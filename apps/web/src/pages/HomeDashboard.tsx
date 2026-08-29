import { useEffect, useRef, useState, useCallback } from 'react'

import { artifactUrl } from '../lib/auth'
import { QualityPanel } from '../components/QualityPanel'

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

  const orbitCenter = { x: 190, y: 200 }
  const orbitR = 140

  // ── Live data-flow (merged into the constellation) ──
  const SPINE_X = 190
  const STATION_YS = [112, 288, 356]
  const wrap = (text: string, width: number): string[] => {
    const lines: string[] = []
    let cur = ''
    for (const word of text.split(/\s+/)) {
      if ((cur + ' ' + word).trim().length > width) {
        if (cur) lines.push(cur.trim())
        cur = word
      } else {
        cur = (cur + ' ' + word).trim()
      }
    }
    if (cur) lines.push(cur.trim())
    return lines.slice(0, 2)
  }

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
  const goalLines = run ? wrap(run.prompt.slice(0, 90), 30) : ['waiting for a run — ask mjane anything']
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

          <div className="dash-flow-head">
            <span className="flow-run-meta">
              {run ? `live run #${run.id} · ${run.model}` : 'no active run'}
            </span>
            <span className={`flow-badge ${flowRunning ? 'on' : ''}`}>
              {flowRunning ? 'LIVE' : (run?.status ?? 'idle')}
            </span>
          </div>

          {/* Orbital SVG with the data spine merged in */}
          <div className="dash-orbital">
            <svg width="380" height="430" viewBox="0 0 380 430">
              {/* data spine + comets (behind the constellation) */}
              <path className="dash-spine" d="M190,52 L190,356" />
              <circle r="4" fill="#57d9a3">
                <animateMotion
                  dur={flowRunning ? '0.9s' : '2.4s'}
                  repeatCount="indefinite"
                  path="M190,52 L190,356"
                />
              </circle>
              <circle r="3" fill="#e0af68" opacity="0.85">
                <animateMotion
                  dur={flowRunning ? '0.9s' : '2.4s'}
                  begin={flowRunning ? '0.45s' : '1.2s'}
                  repeatCount="indefinite"
                  path="M190,52 L190,356"
                />
              </circle>
              <circle cx={orbitCenter.x} cy={orbitCenter.y} r={orbitR} fill="none" stroke="#ffffff12" strokeWidth="1" strokeDasharray="4 8" />
              <circle cx={orbitCenter.x} cy={orbitCenter.y} r={orbitR - 26} fill="none" stroke="#ffffff08" strokeWidth="1" strokeDasharray="2 10" />

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

              {/* Goal node */}
              <g className="flow-goal">
                <circle cx={SPINE_X} cy={26} r="13" className="flow-goal-node" >
                  {(run && flowRunning) && (
                    <animate attributeName="opacity" values="0.7;1;0.7" dur="1.6s" repeatCount="indefinite" />
                  )}
                </circle>
                <text x={SPINE_X} y={30} textAnchor="middle" fontSize="13">🎯</text>
                {goalLines.map((line, i) => (
                  <text key={i} x={SPINE_X} y={48 + i * 11} textAnchor="middle" className="flow-goal-text">
                    {i === 0 ? (run?.prompt ? 'goal: ' + line : line) : line}
                  </text>
                ))}
              </g>

              {/* Step stations along the spine */}
              {uniqueTools.slice(0, 3).map((step, i) => {
                const y = STATION_YS[i]
                const active = step === lastTool && flowRunning
                return (
                  <g key={step.id} className={active ? 'flow-station active' : 'flow-station'}>
                    {active && (
                      <circle cx={SPINE_X} cy={y} r="17">
                        <animate attributeName="opacity" values="0.15;0.5;0.15" dur="1s" repeatCount="indefinite" />
                      </circle>
                    )}
                    <rect x={SPINE_X - 78} y={y - 12} width={156} height={24} rx={12} />
                    <text x={SPINE_X - 66} y={y + 4} fontSize="13">{step.kind === 'delegate' ? '🤝' : '⚙️'}</text>
                    <text x={SPINE_X - 48} y={y + 4} className="flow-station-label">{step.label}</text>
                    <text x={SPINE_X + 62} y={y + 4} textAnchor="end" className="flow-station-detail">{step.detail.slice(0, 20)}</text>
                  </g>
                )
              })}
              {uniqueTools.length === 0 && (
                <g className="flow-station">
                  <rect x={SPINE_X - 78} y={STATION_YS[0] - 12} width={156} height={24} rx={12} />
                  <text x={SPINE_X - 48} y={STATION_YS[0] + 4} className="flow-station-label">act — no tools yet</text>
                </g>
              )}

              {/* Output node */}
              <g className="flow-output">
                <circle cx={SPINE_X} cy={386} r="17" className={`flow-output-node ${outputIsImage ? 'has-image' : ''}`}>
                  <animate attributeName="opacity" values="0.7;1;0.7" dur="2.4s" repeatCount="indefinite" />
                </circle>
                {outputIsImage && artifactStep ? (
                  <a href={artifactUrl(artifactStep.artifactId)} target="_blank" rel="noreferrer">
                    <clipPath id="output-clip">
                      <circle cx={SPINE_X} cy={386} r="15" />
                    </clipPath>
                    <image
                      href={artifactUrl(artifactStep.artifactId)}
                      x={SPINE_X - 15}
                      y={371}
                      width={30}
                      height={30}
                      clipPath="url(#output-clip)"
                      preserveAspectRatio="xMidYMid slice"
                    />
                  </a>
                ) : (
                  <text x={SPINE_X} y={390} textAnchor="middle" fontSize="13">🖼️</text>
                )}
                <text x={SPINE_X} y={414} textAnchor="middle" className="flow-output-text">
                  {outputIsImage && artifactStep
                    ? (artifactStep.filename ?? 'output').slice(0, 34)
                    : lastMessage
                      ? `output · ${lastMessage.detail.slice(0, 42)}`
                      : run && !flowRunning
                        ? run.status
                        : 'output · data lands here…'}
                </text>
              </g>
            </svg>
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

          <QualityPanel />

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
