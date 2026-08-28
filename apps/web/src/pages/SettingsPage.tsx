import { useEffect, useState } from 'react'
import type { ProviderKind } from '@xtiand/shared'

import { api } from '../lib/api'
import { ModelPicker } from '../components/ModelPicker'
import { AccountSecurity } from '../components/AccountSecurity'

interface ProviderRow {
  id: number
  label: string
  kind: ProviderKind
  baseUrl: string
  hasKey: boolean
}

const PROVIDER_PRESETS: { label: string; kind: ProviderKind; baseUrl: string }[] = [
  { label: 'OpenAI', kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1' },
  { label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { label: 'OpenRouter', kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'OpenCode Zen', kind: 'openai-compat', baseUrl: 'https://opencode.ai/zen/v1' },
  { label: 'Ollama (local)', kind: 'openai-compat', baseUrl: 'http://localhost:11434/v1' },
]

interface ImageCfg {
  provider: 'openai' | 'flux' | 'stable' | 'nvidia'
  apiKey: string
  model: string
  baseUrl: string
  hasKey: boolean
}

const IMAGE_PROVIDERS: { value: ImageCfg['provider']; label: string }[] = [
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'openai', label: 'OpenAI DALL·E / gpt-image' },
  { value: 'flux', label: 'Flux' },
  { value: 'stable', label: 'Stable Diffusion' },
]

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [kind, setKind] = useState<ProviderKind>('openai-compat')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState('')
  const [, forceTick] = useState(0)

  const [imgCfg, setImgCfg] = useState<ImageCfg | null>(null)
  const [imgKey, setImgKey] = useState('')
  const [imgTest, setImgTest] = useState('')

  const load = (): void => {
    api.get<ProviderRow[]>('/api/providers').then(setProviders).catch(() => undefined)
  }

  useEffect(load, [])
  useEffect(() => {
    api.get<ImageCfg>('/api/image-config').then((c) => setImgCfg(c)).catch(() => undefined)
  }, [])

  const saveImageCfg = async (): Promise<void> => {
    if (!imgCfg) return
    const next: ImageCfg = { ...imgCfg, apiKey: imgKey || imgCfg.apiKey }
    const saved = await api.put<ImageCfg>('/api/image-config', next)
    setImgCfg(saved)
    setImgKey('')
    setStatus(`image generation → ${saved.provider} (${saved.model})`)
  }

  const testImageCfg = async (): Promise<void> => {
    if (!imgCfg?.hasKey) return setImgTest('no image key yet — save config first')
    setImgTest('generating a tiny test image…')
    try {
      const r = await api.post<{ ok: boolean; error?: string; format?: string }>('/api/image-config/test')
      setImgTest(r.ok ? `ok — generated ${r.format} test image (key works!)` : `failed: ${r.error}`)
    } catch (e: unknown) {
      setImgTest(`failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

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
        <div className="provider-presets">
          {PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="chip chip--preset"
              onClick={() => {
                setLabel(preset.label)
                setKind(preset.kind)
                setBaseUrl(preset.baseUrl)
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
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

      {/* Image generation config */}
      <section className="panel">
        <h2>Image generation</h2>
        <p className="hint">
          Backend for <code>image_generate</code> (real photorealistic images). The creative agent and mjane can use it,
          and can also <em>view</em> images via <code>image_read</code> when the model supports vision.
        </p>
        {imgCfg ? (
          <div className="provider-form provider-form--col">
            <select
              value={imgCfg.provider}
              onChange={(e) =>
                setImgCfg({
                  ...imgCfg,
                  provider: e.target.value as ImageCfg['provider'],
                  model: '',
                  baseUrl: '',
                })
              }
            >
              {IMAGE_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              placeholder="API key"
              type="password"
              value={imgKey}
              onChange={(e) => setImgKey(e.target.value)}
            />
            {imgCfg.hasKey && <span className="chip chip--sev-info">key saved (••••)</span>}
            <input
              placeholder="model (leave blank for default)"
              value={imgCfg.model}
              onChange={(e) => setImgCfg({ ...imgCfg, model: e.target.value })}
            />
            <input
              placeholder="base url (leave blank for default)"
              value={imgCfg.baseUrl}
              onChange={(e) => setImgCfg({ ...imgCfg, baseUrl: e.target.value })}
            />
            <div className="row gap">
              <button type="button" onClick={() => void saveImageCfg()}>
                Save image config
              </button>
              <button type="button" className="chip" onClick={() => void testImageCfg()}>
                Test backend
              </button>
            </div>
            {imgTest && <p className="mono status">{imgTest}</p>}
          </div>
        ) : (
          <p className="hint">loading…</p>
        )}
      </section>

      <AccountSecurity />

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
