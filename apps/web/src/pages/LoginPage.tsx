import { useState } from 'react'

import { setToken } from '../lib/auth'

const API = '/api'

interface LoginResult {
  token?: string
  error?: string
}

export function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [totpEnabled, setTotpEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [recoverEmail, setRecoverEmail] = useState('')
  const [recoverMsg, setRecoverMsg] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, totp }),
      })
      const data = (await res.json()) as LoginResult
      if (!res.ok || !data.token) {
        if (res.status === 423) setError('Account temporarily locked — try again later.')
        else setError(data.error || 'Login failed')
        if (data.error === 'invalid TOTP code') setTotpEnabled(true)
        return
      }
      setToken(data.token)
    } catch {
      setError('Could not reach the API')
    } finally {
      setBusy(false)
    }
  }

  const requestRecovery = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setRecoverMsg(null)
    try {
      const res = await fetch(`${API}/auth/recovery/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: recoverEmail }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; notice?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'request failed')
        return
      }
      setRecoverMsg(
        data.notice && data.notice !== '' ? data.notice : 'if an account exists for that email, a link was sent',
      )
    } catch {
      setError('could not reach the API')
    } finally {
      setBusy(false)
    }
  }

  if (recovering) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={requestRecovery}>
          <h1>✨ xtiandOS</h1>
          <p className="login-sub">Password recovery</p>
          <label>
            email on your account
            <input
              type="email"
              value={recoverEmail}
              onChange={(e) => setRecoverEmail(e.target.value)}
              autoFocus
              autoComplete="email"
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          {recoverMsg && <div className="mono status">{recoverMsg}</div>}
          <button type="submit" disabled={busy || !recoverEmail}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
          <button type="button" className="login-link" onClick={() => { setRecovering(false); setRecoverMsg(null) }}>
            ← back to sign in
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>✨ xtiandOS</h1>
        <p className="login-sub">Sign in to your control plane</p>
        <label>
          username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {totpEnabled && (
          <label>
            authenticator code
            <input value={totp} onChange={(e) => setTotp(e.target.value)} autoComplete="one-time-code" inputMode="numeric" />
          </label>
        )}
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" className="login-link" onClick={() => { setError(null); setRecovering(true) }}>
          forgot password?
        </button>
      </form>
    </div>
  )
}