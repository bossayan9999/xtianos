import { useEffect, useRef, useState } from 'react'

export type ChatMode = 'chat' | 'plan' | 'build'

const STAGES = [
  { key: 'memory', label: 'Memory RAG', hint: 'recalling context' },
  { key: 'plan', label: 'Plan', hint: 'thinking' },
  { key: 'tools', label: 'Tools', hint: 'acting' },
  { key: 'synthesize', label: 'Synthesize', hint: 'writing answer' },
]

interface Props {
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  running: boolean
  /** live signal of what mjane is doing right now */
  activeStage: string | null
  toolCount: number
}

/**
 * Mode switcher + animated data-flow pipeline showing how mjane's answer
 * travels through her brain while she works.
 */
export function WorkflowBar({ mode, onModeChange, running, activeStage, toolCount }: Props): React.JSX.Element {
  const [flow, setFlow] = useState<number[]>([])
  const canvasRef = useRef<HTMLDivElement>(null)

  // ambient particle flow while running
  useEffect(() => {
    if (!running) {
      setFlow([])
      return
    }
    const id = setInterval(() => {
      setFlow((prev) => [...prev.slice(-14), Date.now()])
    }, 220)
    return () => clearInterval(id)
  }, [running])

  const activeIndex = (() => {
    if (activeStage === 'tools') return 2
    if (activeStage === 'plan') return 1
    if (activeStage === 'message') return 3
    if (running) return 0
    return -1
  })()

  return (
    <div className="workflow-bar">
      <div className="mode-switch" role="tablist">
        {(['chat', 'plan', 'build'] as ChatMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`mode-btn mode-${m} ${mode === m ? 'active' : ''}`}
            onClick={() => onModeChange(m)}
          >
            {m === 'chat' ? '💬 Chat' : m === 'plan' ? '🗺️ Plan' : '🔨 Build'}
          </button>
        ))}
      </div>

      <div ref={canvasRef} className={`pipeline ${running ? 'running' : ''}`}>
        {STAGES.map((stage, i) => (
          <span key={stage.key} className="pipeline-stage-wrap">
            <span
              className={`pipeline-stage ${i === activeIndex ? 'active' : ''} ${i < activeIndex ? 'done' : ''}`}
              title={stage.hint}
            >
              {stage.label}
              {stage.key === 'tools' && toolCount > 0 && (
                <span className="tool-count">{toolCount}</span>
              )}
            </span>
            {i < STAGES.length - 1 && (
              <span className="pipeline-wire">
                {running && flow.map((t) => (
                  <i key={t} className="particle" style={{ animationDelay: `${(Date.now() - t) % 5}00ms` }} />
                ))}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
