import { useState } from 'react'

const API = '/api'

export function ResetPasswordPage({ code, onCleared }: { code: string; onCleared: () => void }) {
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (next !== confirm) return setError('passwords do not match')
    if (next.length < 8) return setError('new password must be at least 8 characters')
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API}/auth/recovery/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, next }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'reset failed')
        return
      }
      setDone(true)
    } catch {
      setError('could not reach the API')
    } finally {
      setBusy(false)
    }
  }

  const backToLogin = (): void => {
    const url = new URL(window.location.href)
    url.searchParams.delete('recovery')
    window.history.replaceState({}, '', url.toString())
    onCleared()
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>✨ xtiandOS</h1>
        {done ? (
          <>
            <p className="login-sub">Password changed. All sessions were signed out.</p>
            <button type="button" onClick={backToLogin}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <p className="login-sub">Choose a new password</p>
            <label>
              new password (min 8 chars)
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoFocus
                autoComplete="new-password"
              />
            </label>
            <label>
              confirm new password
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {error && <div className="login-error">{error}</div>}
            <button type="submit" disabled={busy || !next || !confirm}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </>
        )}
      </form>
    </div>
  )
}