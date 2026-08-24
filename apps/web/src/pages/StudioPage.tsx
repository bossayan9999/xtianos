import { useEffect, useState } from 'react'
import { api, sseStream } from '../lib/api'
import { ModelPicker } from '../components/ModelPicker'

interface ArtifactRow {
  id: number
  kind: string
  filename: string
  mime: string
  textPreview: string | null
  createdAt: string
}

export function StudioPage() {
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([])
  const [prompt, setPrompt] = useState('')
  const [modelSpec, setModelSpec] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState('')

  const load = (): void => {
    api.get<ArtifactRow[]>('/api/artifacts').then(setArtifacts).catch(() => undefined)
    api.get<{ defaultModel: string | null }>('/api/providers/default-model')
      .then((r) => setModelSpec(r.defaultModel))
      .catch(() => undefined)
  }

  useEffect(load, [])

  const generate = async (): Promise<void> => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setLog('')
    try {
      let conversationId: number
      try {
        const conversation = await api.post<{ id: number }>('/api/chat')
        conversationId = conversation.id
      } catch {
        throw new Error('could not create conversation')
      }
      await sseStream(
        `/api/chat/${conversationId}/stream`,
        {
          content:
            `${prompt}\n\nGenerate the result and save it with artifact_save (kind + mime + filename). ` +
            'For images call image generation via web_fetch of an API or produce SVG code saved as .svg.',
          model: modelSpec,
        },
        (_e, data) => {
          const step = data as { type: string; data: unknown }
          if (step.type === 'tool-start') setLog((prev) => `${prev}\n⚙ ${String((step.data as { name: string }).name)}`)
          else if (step.type === 'error') setLog((prev) => `${prev}\n⚠️ ${String(step.data)}`)
        },
      )
      load()
    } catch (error: unknown) {
      setLog(`⚠️ ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="studio-page">
      <section className="panel">
        <h2>Artifact studio</h2>
        <p className="hint">
          Describe an artifact — mjane generates files, code, images (SVG/API), docs and saves them here.
        </p>
        <div className="chat-toolbar" style={{ padding: '8px 0' }}>
          <ModelPicker value={modelSpec} onChange={setModelSpec} />
        </div>
        <textarea
          rows={3}
          placeholder="e.g. a dark-themed landing page for my homelab; a logo as SVG; a python backup script…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button type="button" disabled={busy} onClick={() => void generate()}>
          {busy ? 'generating…' : 'Generate'}
        </button>
        {log && <pre className="mono status">{log}</pre>}
      </section>

      <section className="panel">
        <h2>Library</h2>
        <ul className="artifact-list">
          {artifacts.map((a) => (
            <li key={a.id}>
              <span className={`chip chip--sev-info`}>{a.kind}</span>
              <strong>{a.filename}</strong>
              <small className="hint mono">{new Date(a.createdAt).toLocaleString()}</small>
              <a href={`/api/artifacts/${a.id}/raw`} target="_blank" rel="noreferrer">
                open
              </a>
            </li>
          ))}
          {artifacts.length === 0 && <li className="hint">Nothing generated yet.</li>}
        </ul>
      </section>
    </div>
  )
}
