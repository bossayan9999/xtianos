import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@xtiand/shared'

import { api, sseStream } from '../lib/api'
import { artifactUrl } from '../lib/auth'
import { ModelPicker } from '../components/ModelPicker'
import { WorkflowBar, type ChatMode } from '../components/WorkflowBar'
import { VoiceSettingsPanel } from '../components/VoiceSettings'
import { CameraModal } from '../components/CameraModal'
import {
  nativeDictationAvailable,
  recordAndTranscribe,
  setSpeakEnabled,
  speak,
  speakEnabled,
  startNativeDictation,
  stopSpeaking,
  type DictationHandle,
} from '../lib/speech'

interface ChatMessageView {
  id: number | string
  role: string
  content: string
  meta?: string[]
  artifacts?: number[]
}

interface StepData {
  type: string
  data: unknown
}

/**
 * Auto-selects the answer format by keyword intent. Returns 'text' when the
 * message doesn't ask for a visual, so the manual selection is preserved.
 */
export function detectOutputFormat(content: string): 'text' | 'image' | 'animation' {
  const t = content.trim()
  if (/\b(animate|animation|animated\s*(gif|svg)?|make\s+it\s+move|into\s+an?\s+animation)\b/i.test(t)) {
    return 'animation'
  }
  if (
    /\b(create|make|generate|draw|design|render|produce|paint)\b.*\b(image|picture|art|artwork|logo|poster|banner|icon|avatar|meme|illustration|visual|svg|diagram|flowchart|flow\s*chart|uml|graph|chart)\b/i.test(t) ||
    /\b(image|picture|artwork|poster|banner)\b.*\b(create|make|generate|draw|design)\b/i.test(t)
  ) {
    return 'image'
  }
  return 'text'
}

export function ChatPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessageView[]>([])
  const [input, setInput] = useState('')
  const [modelSpec, setModelSpec] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [listening, setListening] = useState(false)
  const [autoSpeak, setAutoSpeak] = useState(speakEnabled())
  const [mode, setMode] = useState<ChatMode>('chat')
  const [activeStage, setActiveStage] = useState<string | null>(null)
  const [toolCount, setToolCount] = useState(0)
  const [showVoiceSettings, setShowVoiceSettings] = useState(false)
  const [showCamera, setShowCamera] = useState(false)
  const [outputFormat, setOutputFormat] = useState<'text' | 'image' | 'animation' | 'data'>('text')
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const dictationRef = useRef<DictationHandle | null>(null)
  const assistantTextRef = useRef('')
  const streamedRef = useRef(false)

  const loadConversations = (): void => {
    api.get<ConversationSummary[]>('/api/chat').then(setConversations).catch(() => undefined)
  }

  useEffect(() => {
    loadConversations()
    api.get<{ defaultModel: string | null }>('/api/providers/default-model')
      .then((r) => setModelSpec(r.defaultModel))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (activeId === null) return
    interface Row {
      id: number
      role: string
      content: string
    }
    api.get<Row[]>(`/api/chat/${activeId}/messages`)
      .then((rows) => setMessages(rows.map((r) => ({ id: r.id, role: r.role, content: r.content }))))
      .catch(() => undefined)
  }, [activeId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])
  const newConversation = async (): Promise<void> => {
    const conversation = await api.post<{ id: number }>('/api/chat')
    loadConversations()
    setActiveId(conversation.id)
    setMessages([])
  }

  const send = async (): Promise<void> => {
    const content = input.trim()
    if (!content || running) return
    let conversationId = activeId
    if (conversationId === null) {
      const conversation = await api.post<{ id: number }>('/api/chat')
      conversationId = conversation.id
      setActiveId(conversationId)
      loadConversations()
    }
    setInput('')
    setRunning(true)
    setVoiceError(null)
    stopSpeaking()
    const autoFormat = detectOutputFormat(content)
    const effFormat: typeof outputFormat = autoFormat !== 'text' ? autoFormat : outputFormat
    if (effFormat !== outputFormat) setOutputFormat(effFormat)
    setActiveStage('memory')
    setToolCount(0)
    setPendingImage(null)
    assistantTextRef.current = ''
    streamedRef.current = false
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content }])
    const assistantId = `a-${Date.now()}`
    setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '' }])

    const appendAssistant = (text: string): void => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + text } : m)),
      )
    }
    const replaceAssistant = (text: string): void => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: text } : m)))
    }
    const setMeta = (update: string[] | ((prev: string[]) => string[])): void => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m
          const base = Array.isArray(m.meta) ? m.meta : []
          const next = typeof update === 'function' ? update(base) : update
          return { ...m, meta: next }
        }),
      )
    }
    const pushArtifact = (id: number): void => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m
          const base = Array.isArray(m.artifacts) ? m.artifacts : []
          if (base.includes(id)) return m
          return { ...m, artifacts: [...base, id] }
        }),
      )
    }

    try {
      await sseStream(`/api/chat/${conversationId}/stream`, { content, model: modelSpec, mode, output: effFormat, images: pendingImage ? [pendingImage] : undefined }, (_e, data) => {
        const step = data as StepData
        if (step.type === 'token') {
          // token-by-token streaming from the provider
          const delta = String(step.data)
          assistantTextRef.current += delta
          streamedRef.current = true
          appendAssistant(delta)
        } else if (step.type === 'message') {
          setActiveStage('synthesize')
          assistantTextRef.current += String(step.data)
          // If we already streamed tokens, this is the authoritative full reply —
          // replace the accumulated stream to avoid duplication.
          if (streamedRef.current) replaceAssistant(String(step.data))
          else appendAssistant(String(step.data))
        } else if (step.type === 'status') {
          setMeta([String(step.data)])
          setActiveStage((prev) => (prev === 'memory' ? 'plan' : prev))
        } else if (step.type === 'delegate') {
          const delegate = step.data as { agentName: string; task: string }
          setActiveStage('delegate')
          setMeta((prev) => [...prev, `→ delegating to ${delegate.agentName}: ${delegate.task.slice(0, 80)}`])
        } else if (step.type === 'delegate-result') {
          const result = step.data as { agentName: string; result: string }
          setMeta((prev) =>
            (Array.isArray(prev) ? prev : []).map((line) =>
              line.startsWith(`→ delegating to ${result.agentName}`) ? `${line} ✓` : line,
            ),
          )
        } else if (step.type === 'sub-agent') {
          const sub = step.data as { agentName: string; type: string; data: unknown }
          if (sub.type === 'tool-start') {
            const tool = sub.data as { name: string }
            setMeta((prev) => [...prev, `  [${sub.agentName}] ⚙ ${tool.name}`])
          } else if (sub.type === 'tool-end') {
            const tool = sub.data as { name: string }
            setMeta((prev) =>
              (Array.isArray(prev) ? prev : []).map((line) =>
                line === `  [${sub.agentName}] ⚙ ${tool.name}` ? `${line} ✓` : line,
              ),
            )
          }
        } else if (step.type === 'tool-start') {
          const tool = step.data as { name: string; scopes: string }
          setActiveStage('tools')
          setToolCount((c) => c + 1)
          setMeta((prev) => [...prev, `⚙ ${tool.name} (${tool.scopes})`])
        } else if (step.type === 'tool-end') {
          const tool = step.data as { name: string; result: string }
          setMeta((prev) =>
            (Array.isArray(prev) ? prev : []).map((line) =>
              line.startsWith(`⚙ ${tool.name}`) ? `${line} ✓` : line,
            ),
          )
        } else if (step.type === 'artifact') {
          const art = step.data as { id?: number }
          if (typeof art.id === 'number' && Number.isFinite(art.id)) pushArtifact(art.id)
        } else if (step.type === 'error') {
          appendAssistant(`\n\n⚠️ ${String(step.data)}`)
        }
      })
    } catch (error: unknown) {
      appendAssistant(`\n⚠️ ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRunning(false)
      setActiveStage(null)
      if (autoSpeak && assistantTextRef.current.trim()) speak(assistantTextRef.current)
      loadConversations()
    }
  }

  const toggleDictation = (): void => {
    if (listening) {
      dictationRef.current?.stop()
      dictationRef.current = null
      setListening(false)
      return
    }
    setVoiceError(null)
    const handle = startNativeDictation(
      (text) => setInput(text),
      (message) => setVoiceError(message),
    )
    if (handle) {
      dictationRef.current = handle
      setListening(true)
      return
    }
    recordAndTranscribe()
      .then((text) => {
        setInput(text)
        setListening(false)
      })
      .catch((error: unknown) => {
        setVoiceError(error instanceof Error ? error.message : String(error))
        setListening(false)
      })
    setListening(true)
  }

  const toggleSpeak = (): void => {
    const next = !autoSpeak
    setAutoSpeak(next)
    setSpeakEnabled(next)
  }

  // Auto-save the global default model whenever one is chosen from the chat picker
  const changeDefaultModel = (spec: string): void => {
    setModelSpec(spec)
    void api.put('/api/providers/default-model', { model: spec }).catch(() => undefined)
  }

  return (
    <div className="chat-page">
      <aside className="chat-sidebar">
        <button type="button" onClick={() => void newConversation()}>
          + New chat
        </button>
        <ul>
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={c.id === activeId ? 'active' : ''}
                onClick={() => setActiveId(c.id)}
              >
                {c.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="chat-main">
        <WorkflowBar
          mode={mode}
          onModeChange={setMode}
          running={running}
          activeStage={activeStage}
          toolCount={toolCount}
        />
        <div className="chat-toolbar">
          <ModelPicker value={modelSpec} onChange={changeDefaultModel} />
          <button
            type="button"
            className={autoSpeak ? 'voice-btn active' : 'voice-btn'}
            title="Speak mjane's replies aloud"
            onClick={toggleSpeak}
          >
            {autoSpeak ? '🔊' : '🔇'}
          </button>
          <button
            type="button"
            className="voice-btn"
            title="Voice settings"
            onClick={() => setShowVoiceSettings(true)}
          >
            🎚️
          </button>
          <button
            type="button"
            className="voice-btn"
            title="Camera — let mjane see"
            onClick={() => setShowCamera(true)}
          >
            📷
          </button>
          <select
            className="output-select"
            title="Answer format"
            value={outputFormat}
            onChange={(e) => {
              const v = e.target.value as typeof outputFormat
              setOutputFormat(v)
              if (v !== 'text') setMode('chat')
            }}
          >
            <option value="text">📝 Text</option>
            <option value="image">🎨 Image</option>
            <option value="animation">🎬 Animation</option>
            <option value="data">📊 Data</option>
          </select>
          <span className="chat-hint">mjane · plan → act → observe loop</span>
        </div>

        <div className="chat-messages">
          {messages.length === 0 && (
            <p className="chat-empty">Talk to mjane — she can search her brain, run tools, manage tasks, use Docker and more.</p>
          )}
          {messages.map((m) => {
            const match = /ARTIFACT:(\d+)/.exec(m.content)
            const artifactIds = Array.from(
              new Set<number>([
                ...(Array.isArray(m.artifacts) ? m.artifacts : []),
                ...(match ? [Number(match[1])] : []),
              ]),
            )
            return (
              <article key={m.id} className={`bubble bubble--${m.role}`}>
                {m.meta && m.meta.length > 0 && (
                  <pre className="bubble-meta">{m.meta.join('\n')}</pre>
                )}
                {artifactIds.map((id) => (
                  <img
                    key={id}
                    className="artifact-image"
                    src={artifactUrl(id)}
                    alt="mjane's generated visual"
                  />
                ))}
                <div className={`bubble-content role-${m.role}`}>
                  {(match ? m.content.replace(/ARTIFACT:\d+/g, '') : m.content) || '…'}
                </div>
              </article>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {showVoiceSettings && (
          <VoiceSettingsPanel onClose={() => setShowVoiceSettings(false)} />
        )}
        {showCamera && (
          <CameraModal onClose={() => setShowCamera(false)} onCapture={(dataUrl) => setPendingImage(dataUrl)} />
        )}
        <div className="chat-input">
          {pendingImage && (
            <div className="pending-image">
              <img src={pendingImage} alt="attachment" />
              <button type="button" onClick={() => setPendingImage(null)}>✕</button>
            </div>
          )}
          {voiceError && <p className="voice-error">🎤 {voiceError}</p>}
          <textarea
            rows={2}
            placeholder={listening ? 'listening…' : running ? 'mjane is working…' : 'ask mjane anything…'}
            value={input}
            disabled={running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button
            type="button"
            className={listening ? 'mic-btn listening' : 'mic-btn'}
            title={nativeDictationAvailable() ? 'Dictate (Web Speech)' : 'Record & transcribe via server'}
            disabled={running && !listening}
            onClick={toggleDictation}
          >
            🎤
          </button>
          <button type="button" disabled={running} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
