import { useEffect, useState } from 'react'

import { api } from '../lib/api'
import { setToken } from '../lib/auth'

interface Me {
  username: string
  displayName: string
  email: string | null
  phone: string | null
  totpEnabled: boolean
}

interface SessionRow {
  id: string
  createdIp: string | null
  userAgent: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  revoked: boolean
  current: boolean
}

export function AccountSecurity() {
  const [me, setMe] = useState<Me | null>(null)
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [accountMsg, setAccountMsg] = useState('')

  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwMsg, setPwMsg] = useState('')

  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [sessionMsg, setSessionMsg] = useState('')

  const [totpSetup, setTotpSetup] = useState(false)
  const [totpSecret, setTotpSecret] = useState('')
  const [totpUri, setTotpUri] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [totpMsg, setTotpMsg] = useState('')
  const [disablePw, setDisablePw] = useState('')
  const [disableCode, setDisableCode] = useState('')

  const loadSessions = (): void => {
    api
      .get<SessionRow[]>('/api/auth/sessions')
      .then(setSessions)
      .catch(() => undefined)
  }

  useEffect(() => {
    api
      .get<Me>('/api/auth/me')
      .then((m) => {
        setMe(m)
        setEmail(m.email ?? '')
        setPhone(m.phone ?? '')
      })
      .catch(() => undefined)
    loadSessions()
  }, [])

  const saveAccount = async (): Promise<void> => {
    const r = await api.put<{ ok: boolean; email: string | null; phone: string | null }>('/api/auth/account', {
      email,
      phone,
    })
    setEmail(r.email ?? '')
    setPhone(r.phone ?? '')
    setAccountMsg('contact info saved')
  }

  const changePassword = async (): Promise<void> => {
    setPwMsg('')
    if (next !== confirm) return setPwMsg('new passwords do not match')
    if (next.length < 8) return setPwMsg('new password must be at least 8 characters')
    const r = await api.post<{ ok: boolean; token?: string }>('/api/auth/password', { current: cur, next })
    if (r.token) setToken(r.token)
    setCur('')
    setNext('')
    setConfirm('')
    setPwMsg('password changed — other sessions were signed out')
  }

  const revokeSession = async (id: string): Promise<void> => {
    await api.del(`/api/auth/sessions/${id}`)
    setSessionMsg('session revoked')
    loadSessions()
  }

  const startTotp = async (): Promise<void> => {
    const r = await api.post<{ secret: string; otpauthUri: string }>('/api/auth/totp/generate')
    setTotpSecret(r.secret)
    setTotpUri(r.otpauthUri)
    setTotpSetup(true)
    setTotpMsg('')
  }

  const confirmTotp = async (): Promise<void> => {
    await api.post('/api/auth/totp/confirm', { code: totpCode })
    setTotpSetup(false)
    setTotpMsg('2FA enabled — you will need your authenticator code to sign in')
    setMe((m) => (m ? { ...m, totpEnabled: true } : m))
  }

  const disableTotp = async (): Promise<void> => {
    await api.post('/api/auth/totp/disable', { password: disablePw, code: disableCode })
    setDisablePw('')
    setDisableCode('')
    setTotpMsg('2FA disabled')
    setMe((m) => (m ? { ...m, totpEnabled: false } : m))
  }

  return (
    <section className="panel">
      <h2>Account &amp; security</h2>

      <div className="acct-block">
        <h3>Contact info</h3>
        <p className="hint">Your email is used for password recovery links.</p>
        <div className="provider-form">
          <input
            placeholder="email (for recovery)"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input placeholder="phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button type="button" onClick={() => void saveAccount()}>
            Save contact info
          </button>
        </div>
        {accountMsg && <p className="mono status">{accountMsg}</p>}
      </div>

      <div className="acct-block">
        <h3>Change password</h3>
        <div className="provider-form">
          <input
            type="password"
            placeholder="current password"
            value={cur}
            onChange={(e) => setCur(e.target.value)}
            autoComplete="current-password"
          />
          <input
            type="password"
            placeholder="new password (min 8)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          <button type="button" onClick={() => void changePassword()} disabled={!cur || !next || !confirm}>
            Change password
          </button>
        </div>
        {pwMsg && <p className="mono status">{pwMsg}</p>}
      </div>

      <div className="acct-block">
        <h3>Two-factor authentication</h3>
        {!me?.totpEnabled && !totpSetup && (
          <div className="row gap">
            <button type="button" onClick={() => void startTotp()}>
              Set up authenticator app
            </button>
          </div>
        )}
        {totpSetup && (
          <div className="acct-totp">
            <p className="hint">
              Add this secret to your authenticator app (Google Authenticator, Authy, 1Password…):
            </p>
            <div className="mono acct-secret" title={totpUri}>
              {totpSecret}
            </div>
            <div className="row gap">
              <input
                placeholder="6-digit code"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode="numeric"
              />
              <button type="button" onClick={() => void confirmTotp()} disabled={totpCode.length !== 6}>
                Confirm &amp; enable
              </button>
            </div>
          </div>
        )}
        {me?.totpEnabled && (
          <div className="acct-totp">
            <p className="hint">Disabled anytime — re-enter your password and a current code.</p>
            <div className="provider-form">
              <input
                type="password"
                placeholder="password"
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
              />
              <input placeholder="current code" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
              <button
                type="button"
                onClick={() => void disableTotp()}
                disabled={!disablePw || disableCode.length !== 6}
              >
                Disable 2FA
              </button>
            </div>
          </div>
        )}
        {totpMsg && <p className="mono status">{totpMsg}</p>}
      </div>

      <div className="acct-block">
        <h3>Active sessions</h3>
        {sessions === null ? (
          <p className="hint">loading…</p>
        ) : (
          <ul className="skill-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <span className="mono">{s.createdIp ?? '?'}</span>
                <span className="hint" title={s.userAgent ?? ''}>
                  {String(s.userAgent ?? '').slice(0, 40)}
                </span>
                <span className="mono hint">
                  {new Date(s.lastUsedAt).toLocaleString()} · exp {new Date(s.expiresAt).toLocaleDateString()}
                </span>
                {s.current && <span className="chip chip--sev-info">this device</span>}
                {s.revoked && <span className="chip chip--sev-warning">revoked</span>}
                {!s.current && !s.revoked && (
                  <button type="button" onClick={() => void revokeSession(s.id)}>
                    revoke
                  </button>
                )}
              </li>
            ))}
            {sessions.length === 0 && <li className="hint">No sessions.</li>}
          </ul>
        )}
        {sessionMsg && <p className="mono status">{sessionMsg}</p>}
      </div>
    </section>
  )
}