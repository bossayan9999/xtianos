import { useCallback, useEffect, useState } from 'react'
import type { BrainNode } from '@xtiand/shared'

import { api } from '../lib/api'

export function CodePage() {
  const [folder, setFolder] = useState('')
  const [tree, setTree] = useState<BrainNode[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [status, setStatus] = useState('')

  const loadTree = useCallback((dir: string): void => {
    const query = dir.length === 0 ? '' : `?path=${encodeURIComponent(dir)}`
    api
      .get<BrainNode[]>(`/api/code/tree${query}`)
      .then((nodes) => {
        setFolder(dir)
        setTree(nodes)
        setStatus(dir.length === 0 ? `root — ${nodes.length} entries` : `${dir} — ${nodes.length} entries`)
      })
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : 'failed to load tree'),
      )
  }, [])

  useEffect(() => {
    loadTree('')
  }, [loadTree])

  const openFile = (node: BrainNode): void => {
    if (node.isDir) {
      loadTree(node.path)
      return
    }
    api
      .get<{ path: string; content: string }>(
        `/api/code/file?path=${encodeURIComponent(node.path)}`,
      )
      .then((file) => {
        setSelected(file.path)
        setContent(file.content)
        setStatus(`${file.path} — ${file.content.length.toLocaleString()} chars`)
      })
      .catch((error: unknown) => {
        setSelected(node.path)
        setContent('')
        setStatus(error instanceof Error ? error.message : 'failed to open file')
      })
  }

  const crumbs = folder
    .split('/')
    .map((part, index) => ({ part, depth: index + 1, path: folder.split('/').slice(0, index + 1).join('/') }))

  return (
    <div className="brain-page">
      <aside className="brain-tree">
        <div className="brain-actions">
          <button type="button" onClick={() => loadTree('')}>
            ↻ Root
          </button>
        </div>
        <ul>
          {tree.map((node) => (
            <li key={node.path}>
              <button
                type="button"
                className={selected === node.path && !node.isDir ? 'active' : ''}
                onClick={() => openFile(node)}
              >
                {node.isDir ? '📁' : '📄'} {node.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="brain-editor">
        <header className="brain-editor__bar">
          <span className="mono">
            {folder.length === 0 ? (
              '~/xtiandOS'
            ) : (
              <>
                <button type="button" className="crumb root" onClick={() => loadTree('')}>
                  ~/xtiandOS
                </button>
                {crumbs.map((crumb) => (
                  <span key={crumb.path}>
                    {'/'}
                    <button
                      type="button"
                      className="crumb"
                      onClick={() => loadTree(crumb.path)}
                    >
                      {crumb.part}
                    </button>
                  </span>
                ))}
              </>
            )}
          </span>
          <span className="brain-status">{status}</span>
        </header>
        {selected ? (
          <pre className="code-content" spellCheck={false}>
            {content.length > 0 ? content : '(unreadable — binary, secret, or too large)'}
          </pre>
        ) : (
          <p className="chat-empty">Open a file to read the xtiandOS source — this is the live repo.</p>
        )}
      </main>
    </div>
  )
}