import { useCallback, useEffect, useState } from 'react'
import type { BrainNode } from '@xtiand/shared'

import { api } from '../lib/api'

interface CleanReport {
  totalNotes: number
  orphans: string[]
  empty: string[]
  stale: string[]
}

export function BrainPage() {
  const [tree, setTree] = useState<BrainNode[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [report, setReport] = useState<CleanReport | null>(null)
  const [status, setStatus] = useState('')

  const loadTree = useCallback((): void => {
    api.get<BrainNode[]>('/api/brain/tree').then(setTree).catch(() => undefined)
  }, [])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  const openFile = (node: BrainNode): void => {
    if (node.isDir) {
      setStatus(`folders: ${node.path}`)
      return
    }
    api
      .get<{ path: string; content: string }>(
        `/api/brain/file?path=${encodeURIComponent(node.path)}`,
      )
      .then((file) => {
        setSelected(file.path)
        setContent(file.content)
        setDirty(false)
      })
      .catch(() => undefined)
  }

  const save = async (): Promise<void> => {
    if (!selected) return
    await api.put('/api/brain/file', { path: selected, content })
    setDirty(false)
    setStatus(`saved ${selected}`)
  }

  const createNote = async (): Promise<void> => {
    const name = prompt('note name', 'New note.md')
    if (!name) return
    const pathName = name.endsWith('.md') ? name : `${name}.md`
    await api.put('/api/brain/file', {
      path: pathName,
      content: `---\ncreated: ${new Date().toISOString()}\n---\n\n# ${pathName.replace(/\.md$/, '')}\n`,
    })
    loadTree()
    setStatus(`created ${pathName}`)
  }

  const cleanReport = async (): Promise<void> => {
    const result = await api.get<CleanReport>('/api/brain/clean-report')
    setReport(result)
  }

  const reindex = async (): Promise<void> => {
    const r = await api.post<{ indexed: number }>('/api/brain/reindex')
    setStatus(`reindexed ${r.indexed} memory chunks`)
  }

  return (
    <div className="brain-page">
      <aside className="brain-tree">
        <div className="brain-actions">
          <button type="button" onClick={() => void createNote()}>
            + Note
          </button>
          <button type="button" onClick={cleanReport}>
            Clean report
          </button>
          <button type="button" onClick={() => void reindex()}>
            Reindex RAG
          </button>
        </div>
        <ul>
          {tree.map((node) => (
            <li key={node.path}>
              <button type="button" onClick={() => openFile(node)}>
                {node.isDir ? '📁' : '📄'} {node.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="brain-editor">
        {report && (
          <div className="clean-report">
            <h3>
              Clean report — {report.totalNotes} notes ·{' '}
              <button type="button" onClick={() => setReport(null)}>
                close
              </button>
            </h3>
            <p><strong>Orphans:</strong> {report.orphans.length === 0 ? 'none 🟢' : report.orphans.join(', ')}</p>
            <p><strong>Near-empty:</strong> {report.empty.length === 0 ? 'none' : report.empty.join(', ')}</p>
            <p><strong>Stale &gt;90d:</strong> {report.stale.length === 0 ? 'none' : report.stale.join(', ')}</p>
          </div>
        )}
        {selected ? (
          <>
            <header className="brain-editor__bar">
              <span className="mono">{selected}</span>
              <span className="brain-status">{status}</span>
              <button type="button" disabled={!dirty} onClick={() => void save()}>
                Save
              </button>
            </header>
            <textarea
              value={content}
              spellCheck={false}
              onChange={(e) => {
                setContent(e.target.value)
                setDirty(true)
              }}
            />
          </>
        ) : (
          <p className="chat-empty">Select a note — this vault is mjane&apos;s brain.</p>
        )}
      </main>
    </div>
  )
}
