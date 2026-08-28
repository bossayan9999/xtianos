import { useEffect, useRef, useState } from 'react'

import { searchSkillRepos } from '../lib/skill-repos'

interface SkillRepoPickerProps {
  value: string
  onChange: (url: string) => void
  onTyped: (value: string) => void
}

export function SkillRepoPicker({ value, onChange, onTyped }: SkillRepoPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const filtered = searchSkillRepos(query)

  return (
    <div className="model-picker mcp-picker" ref={boxRef}>
      <input
        placeholder="search known skill repos or paste a GitHub URL…"
        value={open ? query : value}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (value !== e.target.value) onTyped(e.target.value)
        }}
        onFocus={() => {
          setOpen(true)
          setQuery(value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && (
        <div className="model-picker__dropdown mcp-picker__dropdown">
          <ul>
            {filtered.map((r) => (
              <li key={r.url}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery('')
                    setOpen(false)
                    onChange(r.url)
                  }}
                >
                  <span className="mcp-picker__name">{r.name}</span>
                  <span className="mcp-picker__desc">{r.description}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="empty">no matching skill repos</li>}
          </ul>
        </div>
      )}
    </div>
  )
}