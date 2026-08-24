import { useEffect, useState } from 'react'
import {
  getSpeechSettings,
  listBrowserVoices,
  saveSpeechSettings,
  type SpeechSettings,
} from '../lib/speech'

const AI_VOICES = [
  { id: 'nova', label: 'Nova — warm young woman (recommended)' },
  { id: 'shimmer', label: 'Shimmer — bright, expressive woman' },
  { id: 'fable', label: 'Fable — soft storyteller' },
  { id: 'alloy', label: 'Alloy — neutral' },
  { id: 'echo', label: 'Echo — calm male' },
  { id: 'onyx', label: 'Onyx — deep male' },
]

interface Props {
  onClose: () => void
}

export function VoiceSettingsPanel({ onClose }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<SpeechSettings>(getSpeechSettings())
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([])
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    setVoices(listBrowserVoices())
    const t = setTimeout(() => setVoices(listBrowserVoices()), 400)
    return () => clearTimeout(t)
  }, [])

  const update = (patch: Partial<SpeechSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSpeechSettings(next)
  }

  const preview = async (): Promise<void> => {
    setPreviewing(true)
    setPreviewError(null)
    const sample =
      "Hi, I'm mjane. This is how I'll sound when I talk to you — hopefully human enough for a late night ops shift."
    try {
      if (settings.engine === 'ai') {
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sample, voice: settings.aiVoice, speed: settings.rate }),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(err.error ?? `HTTP ${res.status}`)
        }
        const blob = await res.blob()
        await new Audio(URL.createObjectURL(blob)).play()
      } else {
        const utterance = new SpeechSynthesisUtterance(sample)
        const voice = voices.find((v) => v.name === settings.browserVoiceName)
        if (voice) {
          const match = window.speechSynthesis.getVoices().find((v) => v.name === voice.name)
          if (match) utterance.voice = match
        }
        utterance.rate = settings.rate
        utterance.pitch = settings.pitch
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(utterance)
      }
    } catch (error: unknown) {
      setPreviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <div className="voice-modal-backdrop" onClick={onClose}>
      <div className="voice-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>🎙️ mjane's voice</h3>
          <button type="button" className="close" onClick={onClose}>
            ✕
          </button>
        </header>

        <label className="field">
          Engine
          <select
            value={settings.engine}
            onChange={(e) => update({ engine: e.target.value as SpeechSettings['engine'] })}
          >
            <option value="ai">AI voice (human-quality, uses your API key)</option>
            <option value="browser">Browser built-in (offline)</option>
          </select>
        </label>

        {settings.engine === 'ai' ? (
          <label className="field">
            Voice
            <select
              value={settings.aiVoice}
              onChange={(e) => update({ aiVoice: e.target.value })}
            >
              {AI_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field">
            Browser voice
            <select
              value={settings.browserVoiceName ?? ''}
              onChange={(e) => update({ browserVoiceName: e.target.value || null })}
            >
              <option value="">Auto-pick most natural female</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          Speed — {settings.rate.toFixed(2)}×
          <input
            type="range"
            min={0.6}
            max={1.4}
            step={0.05}
            value={settings.rate}
            onChange={(e) => update({ rate: Number(e.target.value) })}
          />
        </label>

        {settings.engine === 'browser' && (
          <label className="field">
            Pitch — {settings.pitch.toFixed(2)}
            <input
              type="range"
              min={0.6}
              max={1.5}
              step={0.05}
              value={settings.pitch}
              onChange={(e) => update({ pitch: Number(e.target.value) })}
            />
          </label>
        )}

        {previewError && <p className="voice-error">{previewError}</p>}

        <footer>
          <button type="button" className="primary" disabled={previewing} onClick={() => void preview()}>
            {previewing ? 'speaking…' : '▶ Preview'}
          </button>
        </footer>
      </div>
    </div>
  )
}
