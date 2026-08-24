import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@xtiand/shared'
import { api } from '../lib/api'

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return models
  return models.filter(
    (m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
  )
}

interface ModelPickerProps {
  value: string | null
  onChange: (modelSpec: string) => void
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.get<ModelInfo[]>('/api/providers/models/catalog').then(setModels).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const filtered = useMemo(() => filterModels(models, query), [models, query])
  const current = models.find((m) => m.id === value)

  return (
    <div className="model-picker" ref={boxRef}>
      <button type="button" className="model-picker__button" onClick={() => setOpen(!open)}>
        ◆ {current?.label ?? value ?? 'select model'} ▾
      </button>
      {open && (
        <div className="model-picker__dropdown">
          <input
            autoFocus
            placeholder="search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul>
            {filtered.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={m.id === value ? 'active' : ''}
                  onClick={() => {
                    onChange(m.id)
                    setOpen(false)
                  }}
                >
                  {m.label}
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="empty">no matches</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
