import { useEffect, useState } from 'react'
import type { ProviderKind } from '@xtiand/shared'

import { api } from '../lib/api'
import { ModelPicker } from '../components/ModelPicker'

interface ProviderRow {
  id: number
  label: string
  kind: ProviderKind
  baseUrl: string
  hasKey: boolean
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [kind, setKind] = useState<ProviderKind>('openai-compat')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState('')
  const [, forceTick] = useState(0)

  const load = (): void => {
    api.get<ProviderRow[]>('/api/providers').then(setProviders).catch(() => undefined)
  }

  useEffect(load, [])

  const addProvider = async (): Promise<void> => {
    if (!label.trim() || !baseUrl.trim()) return
    await api.post<{ id: number }>('/api/providers', { label, baseUrl, kind, apiKey })
    setStatus(`provider "${label}" saved — key encrypted at rest`)
    setLabel('')
    setApiKey('')
    load()
    forceTick((n) => n + 1)
  }

  const saveKey = async (id: number): Promise<void> => {
    const key = prompt('paste API key')
    if (!key) return
    await api.patch(`/api/providers/${id}/key`, { apiKey: key })
    setStatus('key updated')
    load()
  }

  const setDefaultModel = async (modelSpec: string): Promise<void> => {
    await api.put('/api/providers/default-model', { model: modelSpec })
    forceTick((n) => n + 1)
    setStatus(`default model → ${modelSpec}`)
  }

  return (
    <div className="settings-page">
      <section className="panel">
        <h2>Default model</h2>
        <ModelPicker value={null} onChange={(m) => void setDefaultModel(m)} />
      </section>

      <section className="panel">
        <h2>AI providers</h2>
        <p className="hint">Keys are AES-256-GCM encrypted with the server master secret; never sent back to the browser.</p>
        <div className="provider-form">
          <input placeholder="label e.g. OpenAI" value={label} onChange={(e) => setLabel(e.target.value)} />
          <select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
            <option value="openai-compat">openai-compatible</option>
            <option value="anthropic">anthropic</option>
          </select>
          <input placeholder="base url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input
            placeholder="API key (optional)"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button type="button" onClick={() => void addProvider()}>
            Add provider
          </button>
        </div>
        {status && <p className="mono status">{status}</p>}
        <ul className="skill-list">
          {providers.map((p) => (
            <li key={p.id}>
              <strong>{p.label}</strong>
              <span className="hint mono">{p.baseUrl}</span>
              <span className={`chip ${p.hasKey ? 'chip--sev-info' : 'chip--sev-warning'}`}>
                {p.hasKey ? 'key set' : 'no key'}
              </span>
              <button type="button" onClick={() => void saveKey(p.id)}>
                {p.hasKey ? 'replace key' : 'add key'}
              </button>
              <button
                type="button"
                onClick={() => void api.del(`/api/providers/${p.id}`).then(load)}
              >
                ✕
              </button>
            </li>
          ))}
          {providers.length === 0 && <li className="hint">No providers yet — add one to bring mjane online.</li>}
        </ul>
      </section>

      <section className="panel">
        <h2>Audit log</h2>
        <AuditList />
      </section>
    </div>
  )
}

function AuditList() {
  const [rows, setRows] = useState<{ id: number; action: string; detail: string; createdAt: string }[]>([])
  useEffect(() => {
    api.get<typeof rows>('/api/audit').then(setRows).catch(() => undefined)
  }, [])
  return (
    <ul className="skill-list mono">
      {rows.map((r) => (
        <li key={r.id}>
          <small>{new Date(r.createdAt).toLocaleTimeString()}</small> — <strong>{r.action}</strong>{' '}
          <span className="hint">{r.detail.slice(0, 80)}</span>
        </li>
      ))}
      {rows.length === 0 && <li className="hint">Nothing audited yet.</li>}
    </ul>
  )
}
