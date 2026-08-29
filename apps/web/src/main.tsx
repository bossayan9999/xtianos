import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { clearToken, getToken, isApiUrl } from './lib/auth'
import './index.css'

const originalFetch = window.fetch.bind(window)

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (isApiUrl(input)) {
    const token = getToken()
    const headers = new Headers(init?.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const res = await originalFetch(input, { ...init, headers } as RequestInit)
    if (
      res.status === 401 &&
      !String(input).includes('/api/auth/login') &&
      !String(input).includes('/api/artifacts/')
    ) {
      clearToken()
    }
    return res
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}