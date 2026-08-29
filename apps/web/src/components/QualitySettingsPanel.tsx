import { useEffect, useState } from 'react'

import { api } from '../lib/api'
import { ModelPicker } from './ModelPicker'

interface QaSettingsResponse {
  settings: { key: string; value: string }[]
  defaults: Record<string, string>
  judgeModel: string | null
  embeddings: { mode: 'feature-hash' | 'provider'; model: string; configured: boolean }
}

export function QualitySettingsPanel() {
  const [data, setData] = useState<QaSettingsResponse | null>(null)
  const [status, setStatus] = useState('')

  const load = (): void => {
    api.get<QaSettingsResponse>('/api/quality/settings').then(setData).catch(() => undefined)
  }
  useEffect(load, [])

  const save = async (key: string, value: string): Promise<void> => {
    try {
      await api.put<{ ok: boolean }>('/api/quality/settings', { key, value })
      setStatus(`${key} → ${value || 'default'}`)
      load()
    } catch (e: unknown) {
      setStatus(`failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!data) return <p className="hint">loading quality settings…</p>
  const val = (key: string): string =>
    data.settings.find((s) => s.key === key)?.value ?? data.defaults[key] ?? ''
  const criticEnabled = val('qa.criticEnabled') === '1'
  const threshold = Number.parseInt(val('qa.threshold'), 10) || 60
  const maxRevisions = Number.parseInt(val('qa.maxRevisions'), 10) || 0
  const judgeRaw = val('qa.judgeModel')

  return (
    <section className="panel">
      <h2>Quality & critic</h2>
      <p className="hint">
        After each chat reply, a judge model grades the answer for groundedness, tone and
        completeness. Low-scoring text answers are automatically revised in place (up to the
        revision limit).{' '}
        <code>openai/llama-agents-contextual-rag</code> is used to score, then the same judge revises.
      </p>

      <div className="qa-row">
        <label className="qa-toggle" htmlFor="qa-critic-enabled">
          <input
            id="qa-critic-enabled"
            type="checkbox"
            checked={criticEnabled}
            onChange={(e) => void save('qa.criticEnabled', e.target.checked ? '1' : '0')}
          />
          <span>
            <strong>Critic enabled</strong>
            <small className="hint">grade every chat answer; skip entirely when off</small>
          </span>
        </label>
      </div>

      <div className="qa-row">
        <label className={`qa-slider ${criticEnabled ? '' : 'disabled'}`}>
          <span>
            <strong>Revision threshold</strong>
            <small className="hint">answers scoring below this get revised</small>
          </span>
          <span className="qa-slider-line">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={threshold}
              disabled={!criticEnabled}
              onChange={(e) => void save('qa.threshold', e.target.value)}
            />
            <code className="qa-slider-value">{threshold}</code>
          </span>
        </label>
        <label className={`qa-slider ${criticEnabled ? '' : 'disabled'}`}>
          <span>
            <strong>Max revisions</strong>
            <small className="hint">how many times a weak answer may be rewritten per turn</small>
          </span>
          <select
            value={maxRevisions}
            disabled={!criticEnabled}
            onChange={(e) => void save('qa.maxRevisions', e.target.value)}
          >
            <option value={0}>0 — never revise</option>
            <option value={1}>1 revision</option>
            <option value={2}>2 revisions</option>
            <option value={3}>3 revisions</option>
          </select>
        </label>
      </div>

      <div className="qa-row qa-row--col">
        <span className="qa-picker-label">
          <strong>Judge model</strong>
          <small className="hint">
            {judgeRaw
              ? data.judgeModel === judgeRaw
                ? 'this model grades & revises answers'
                : `env JUDGE_MODEL overrides to ${data.judgeModel}`
              : 'uses your default chat model'}
          </small>
        </span>
        <div className="qa-picker-line">
          <ModelPicker value={judgeRaw || null} onChange={(m) => void save('qa.judgeModel', m)} />
          {judgeRaw && (
            <button type="button" className="chip" onClick={() => void save('qa.judgeModel', '')}>
              use default
            </button>
          )}
        </div>
      </div>

      <div className="qa-row">
        <span>
          <strong>Memory embeddings</strong>
          <small className="hint">
            semantic search backend — {data.embeddings.model} ({data.embeddings.mode})
            {!data.embeddings.configured &&
              data.embeddings.mode === 'feature-hash' &&
              '; set EMBEDDINGS_BASE_URL + EMBEDDINGS_API_KEY in .env for provider embeddings (dim 1536)'}
          </small>
        </span>
      </div>

      {status && <p className="mono status">{status}</p>}
    </section>
  )
}