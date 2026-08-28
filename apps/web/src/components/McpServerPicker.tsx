import { useEffect, useRef, useState } from 'react'

import { knownMcpServers } from '../lib/mcp-servers'

export interface McpServerOption {
  name: string
  description: string
  command?: string
  args?: string
  url?: string
  transport: 'stdio' | 'http' | 'sse'
}

export function searchServers(query: string): McpServerOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return knownMcpServers
  return knownMcpServers.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )
}

interface McpServerPickerProps {
  value: string
  onChange: (option: McpServerOption) => void
  onTyped: (value: string) => void
}

export function McpServerPicker({ value, onChange, onTyped }: McpServerPickerProps) {
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

  const filtered = searchServers(query)

  const pick = (s: McpServerOption): void => {
    setQuery('')
    setOpen(false)
    onChange(s)
  }

  return (
    <div className="model-picker mcp-picker" ref={boxRef}>
      <input
        placeholder="search known MCP servers or type a name…"
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
            {filtered.map((s) => (
              <li key={s.name}>
                <button type="button" onClick={() => pick(s)}>
                  <span className="mcp-picker__name">{s.name}</span>{' '}
                  <span className="mcp-picker__tag mono">{s.transport}</span>
                  <span className="mcp-picker__desc">{s.description}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="empty">no matching servers</li>}
          </ul>
        </div>
      )}
    </div>
  )
}