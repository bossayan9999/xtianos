import { useEffect, useState, useCallback } from 'react'
import { ChatPage } from './ChatPage'
import { HomeDashboard } from './HomeDashboard'
import { MissionTerminal } from '../components/MissionTerminal'

/**
 * Combined landing tab: mjane chat as the main area with a toggleable
 * dashboard panel (agent constellation + live data flow) on the right,
 * and a live terminal showing what mjane + agents are doing (with user
 * terminals connected to the desktop host).
 */
export function HomePage() {
  const [showDash, setShowDash] = useState(true)
  const [showTerm, setShowTerm] = useState(true)

  return (
    <div className="home">
      <div className="home-bar">
        <button
          type="button"
          className={`home-toggle ${showDash ? 'active' : ''}`}
          onClick={() => setShowDash((s) => !s)}
        >
          🎛️ Dashboard
        </button>
        <button
          type="button"
          className={`home-toggle ${!showDash ? 'active' : ''}`}
          onClick={() => setShowDash((s) => !s)}
        >
          💬 mjane
        </button>
        <button
          type="button"
          className={`home-toggle term ${showTerm ? 'active' : ''}`}
          onClick={() => setShowTerm((s) => !s)}
        >
          ⌨️ Terminal
        </button>
        <span className="home-hint">talk to mjane · watch agents delegate · live code + desktop terminals</span>
      </div>

      <div className={`home-layout ${showDash ? 'with-dash' : 'chat-only'}`}>
        <div className="home-chat">
          <ChatPage />
        </div>
        {showDash && (
          <div className="home-dash">
            <HomeDashboard compact />
          </div>
        )}
      </div>

      {showTerm && (
        <div className="home-terminal">
          <MissionTerminal />
        </div>
      )}
    </div>
  )
}

