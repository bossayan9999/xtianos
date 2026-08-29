import { useEffect, useState } from 'react'

const API = '/api'

interface Summary {
  aggregate: {
    runs: number
    avgLatencyMs: number
    p95LatencyMs: number
    avgScore: number | null
    scoredRuns: number
    groundedRuns: number
    flaggedRuns: number
    revisionsTotal: number
    runsLast24h: number
    errorRuns: number
    flagCounts: Record<string, number>
  }
  feedback: { total: number; ups: number; downs: number }
  recentLow: {
    id: number
    conversationId: number
    title: string
    content: string
    qualityScore: number
    qualityFlags: string[]
    qualityRevisions: number
    grounded: boolean
    latencyMs: number
  }[]
}

export function QualityPanel() {
  const [data, setData] = useState<Summary | null>(null)

  useEffect(() => {
    const load = (): void => {
      fetch(`${API}/quality/summary`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then(setData)
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [])

  if (!data) return null
  const a = data.aggregate
  const topFlags = Object.entries(a.flagCounts)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 4)
  const feedbackRatio = a.runs > 0 ? data.feedback.total / Math.max(a.runs, 1) : 0

  return (
    <div className="panel">
      <h3 className="dash-panel-title">Quality & Speed</h3>
      <div className="qa-dash-grid">
        <div className="qa-dash-cell">
          <span className="qa-dash-value">{a.avgScore !== null ? `${a.avgScore}` : '–'}</span>
          <span className="qa-dash-label">avg score /100</span>
        </div>
        <div className="qa-dash-cell">
          <span className="qa-dash-value">{a.avgLatencyMs > 0 ? `${(a.avgLatencyMs / 1000).toFixed(1)}s` : '–'}</span>
          <span className="qa-dash-label">avg latency</span>
        </div>
        <div className="qa-dash-cell">
          <span className="qa-dash-value">{a.p95LatencyMs > 0 ? `${(a.p95LatencyMs / 1000).toFixed(1)}s` : '–'}</span>
          <span className="qa-dash-label">p95 latency</span>
        </div>
        <div className="qa-dash-cell">
          <span className="qa-dash-value">
            {data.feedback.ups}
            <span className="qa-dash-sub">/</span>
            {data.feedback.downs}
          </span>
          <span className="qa-dash-label">thumbs ↑/↓</span>
        </div>
      </div>

      <div className="qa-dash-rows">
        <div className="qa-dash-row">
          <span>Runs</span>
          <strong>{a.runs}</strong>
          <small className="hint">{a.runsLast24h} in last 24h</small>
        </div>
        <div className="qa-dash-row">
          <span>Grounded</span>
          <strong>
            {a.groundedRuns}/{a.scoredRuns || a.runs}
          </strong>
        </div>
        <div className="qa-dash-row">
          <span>Revisions</span>
          <strong>{a.revisionsTotal}</strong>
          <small className="hint">auto-rewrites</small>
        </div>
        <div className="qa-dash-row">
          <span>Errors</span>
          <strong>{a.errorRuns}</strong>
        </div>
        <div className="qa-dash-row">
          <span>Feedback rate</span>
          <strong>{Math.round(feedbackRatio * 100)}%</strong>
          <small className="hint">{data.feedback.total} votes</small>
        </div>
      </div>

      {topFlags.length > 0 && (
        <div className="qa-dash-flags">
          {topFlags.map(([flag, count]) => (
            <span key={flag} className="qa-dash-flag">
              {flag} ×{count}
            </span>
          ))}
        </div>
      )}

      {data.recentLow.length > 0 && (
        <div className="qa-dash-low">
          <span className="hint">low-scoring recent answers</span>
          <ul>
            {data.recentLow.map((m) => (
              <li key={m.id} title={m.content.slice(0, 240)}>
                <span className={`qa-badge qa-badge--bad`}>{m.qualityScore}/100</span>
                <span className="qa-dash-low-text">
                  {m.title || `conversation #${m.conversationId}`} — {m.content.slice(0, 60)}…
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}