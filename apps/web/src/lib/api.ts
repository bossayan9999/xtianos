async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${init?.method ?? 'GET'} ${url} → ${res.status}`)
  }
  return (await res.json()) as T
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: object) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(url: string, body?: object) =>
    request<T>(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T>(url: string, body?: object) =>
    request<T>(url, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}

export async function sseStream(
  url: string,
  body: object,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep = buffer.indexOf('\n\n')
    while (sep >= 0) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (dataLines.length > 0) {
        try {
          onEvent(event, JSON.parse(dataLines.join('\n')))
        } catch {
          onEvent(event, dataLines.join('\n'))
        }
      }
      sep = buffer.indexOf('\n\n')
    }
  }
}
