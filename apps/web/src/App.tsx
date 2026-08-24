import { useState } from 'react'

import { ChatPage } from './pages/ChatPage'
import { BrainPage } from './pages/BrainPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { SkillsPage } from './pages/SkillsPage'
import { StudioPage } from './pages/StudioPage'
import { TerminalPage } from './pages/TerminalPage'
import { SettingsPage } from './pages/SettingsPage'
import './index.css'

const TABS = [
  { id: 'chat', label: '💬 mjane', el: ChatPage },
  { id: 'brain', label: '🧠 Brain', el: BrainPage },
  { id: 'projects', label: '📋 Projects', el: ProjectsPage },
  { id: 'skills', label: '🧩 Skills & MCP', el: SkillsPage },
  { id: 'studio', label: '🎨 Studio', el: StudioPage },
  { id: 'terminal', label: '⌨️ Terminal', el: TerminalPage },
  { id: 'settings', label: '⚙️ Settings', el: SettingsPage },
] as const

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('chat')
  const Active = TABS.find((t) => t.id === tab)?.el ?? ChatPage

  return (
    <div className="app">
      <header id="topbar">
        <h1>✨ xtiandOS</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="updated">mjane copilot manager · v0.1</span>
      </header>
      <main className="page">
        <Active />
      </main>
    </div>
  )
}
