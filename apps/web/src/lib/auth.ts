const TOKEN_KEY = 'xtiandos.session'
const AUTHED_EVENT = 'xtiandos:authed'
const UNAUTH_EVENT = 'xtiandos:unauth'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  window.dispatchEvent(new Event(AUTHED_EVENT))
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  window.dispatchEvent(new Event(UNAUTH_EVENT))
}

export function onAuthChange(fn: () => void): () => void {
  const handle = (): void => fn()
  window.addEventListener(AUTHED_EVENT, handle)
  window.addEventListener(UNAUTH_EVENT, handle)
  return () => {
    window.removeEventListener(AUTHED_EVENT, handle)
    window.removeEventListener(UNAUTH_EVENT, handle)
  }
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function artifactUrl(id: number | string | null | undefined): string {
  if (id === undefined || id === null) return ''
  const base = `/api/artifacts/${id}/raw`
  const token = getToken()
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

export function isApiUrl(input: RequestInfo | URL): boolean {
  const s = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return (
    s.startsWith('/api/') ||
    s.includes('/api/') ||
    s.startsWith('http://127.0.0.1:3101') ||
    s.startsWith('http://localhost:3101')
  )
}