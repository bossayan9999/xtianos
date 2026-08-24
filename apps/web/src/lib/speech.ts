export interface SpeechSettings {
  engine: 'browser' | 'ai'
  browserVoiceName: string | null
  aiVoice: string // nova | shimmer | alloy | echo | fable | onyx
  rate: number
  pitch: number
}

const SETTINGS_KEY = 'mjane-voice-settings'
const SPEAK_ENABLED_KEY = 'mjane-speak-enabled'

export function getSpeechSettings(): SpeechSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<SpeechSettings>) }
  } catch { /* ignore */ }
  return defaultSettings()
}

function defaultSettings(): SpeechSettings {
  return { engine: 'ai', browserVoiceName: null, aiVoice: 'nova', rate: 1.0, pitch: 1.0 }
}

export function saveSpeechSettings(settings: SpeechSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export interface DictationHandle {
  stop: () => void
}


type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (w['SpeechRecognition'] ?? w['webkitSpeechRecognition'] ?? null) as
    | (new () => SpeechRecognitionLike)
    | null
}

export function nativeDictationAvailable(): boolean {
  return getRecognitionCtor() !== null
}

/** Chromium path: live dictation via the Web Speech API. */
export function startNativeDictation(
  onFinalText: (text: string) => void,
  onError: (message: string) => void,
): DictationHandle | null {
  const Ctor = getRecognitionCtor()
  if (!Ctor) return null
  const recognition = new Ctor()
  recognition.lang = navigator.language || 'en-US'
  recognition.continuous = false
  recognition.interimResults = true
  let finalTranscript = ''
  recognition.onresult = (event) => {
    let interim = ''
    for (let i = 0; i < event.results.length; i += 1) {
      const alt = event.results[i][0]
      if (i === event.results.length - 1 && !finalTranscript) interim = alt.transcript
      else finalTranscript += alt.transcript
    }
    if (finalTranscript || interim) onFinalText((finalTranscript + interim).trim())
  }
  recognition.onerror = (event) => onError(event.error ?? 'dictation error')
  recognition.onend = () => {
    if (finalTranscript.trim()) onFinalText(finalTranscript.trim())
  }
  try {
    recognition.start()
  } catch {
    return null
  }
  return { stop: () => recognition.stop() }
}

/**
 * Fallback path (Firefox): record via MediaRecorder, transcribe server-side
 * through the configured OpenAI-compatible provider.
 */
export async function recordAndTranscribe(onLevel?: (level: number) => void): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (e) => chunks.push(e.data)

  const audioCtx = new AudioContext()
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 256
  audioCtx.createMediaStreamSource(stream).connect(analyser)
  const data = new Uint8Array(analyser.frequencyBinCount)
  let raf = 0
  const tick = (): void => {
    analyser.getByteFrequencyData(data)
    onLevel?.(data.reduce((a, b) => a + b, 0) / data.length / 255)
    raf = requestAnimationFrame(tick)
  }
  tick()

  return new Promise<string>((resolve, reject) => {
    recorder.onstop = () => {
      cancelAnimationFrame(raf)
      stream.getTracks().forEach((t) => t.stop())
      void audioCtx.close()
      const blob = new Blob(chunks, { type: 'audio/webm' })
      if (blob.size < 1200) {
        reject(new Error('no speech captured'))
        return
      }
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const base64 = String(reader.result).split(',')[1] ?? ''
          const res = await fetch('/api/voice/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: base64, mime: blob.type }),
          })
          const json = (await res.json()) as { text?: string; error?: string }
          if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
          resolve(json.text ?? '')
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      reader.readAsDataURL(blob)
    }
    recorder.start()
    setTimeout(
      () => {
        if (recorder.state !== 'inactive') recorder.stop()
      },
      15_000,
    )
  })
}

export function speakEnabled(): boolean {
  return localStorage.getItem(SPEAK_ENABLED_KEY) === '1'
}

export function setSpeakEnabled(value: boolean): void {
  localStorage.setItem(SPEAK_ENABLED_KEY, value ? '1' : '0')
  if (!value) stopSpeaking()
}

/** Strip markdown noise so mjane sounds natural when read aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' a link ')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '').replace(/\u{FE0F}/gu, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_~#>]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Split into speakable sentences (handles abbreviations minimally). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const PREFERRED_VOICES = [
  'aria',
  'jenny',
  'emma',
  'samantha',
  'serena',
  'google uk english female',
  'google us english',
  'zira',
  'victoria',
  'karen',
  'moira',
  'female',
]

/** Pick the most natural-sounding voice the browser offers. */
export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const pool = english.length > 0 ? english : voices
  for (const needle of PREFERRED_VOICES) {
    const match = pool.find((v) => v.name.toLowerCase().includes(needle))
    if (match) return match
  }
  const neural = pool.find((v) => /neural|natural|premium|enhanced/i.test(v.name))
  if (neural) return neural
  return pool[0] ?? null
}

export function stopSpeaking(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  if (currentAiAudio) {
    currentAiAudio.pause()
    currentAiAudio = null
  }
}

/** All english-ish voices for the settings picker. */
export function listBrowserVoices(): { name: string; lang: string }[] {
  if (!('speechSynthesis' in window)) return []
  return window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith('en'))
    .map((v) => ({ name: v.name, lang: v.lang }))
}

let currentAiAudio: HTMLAudioElement | null = null

/** Human-quality TTS through the configured OpenAI-compatible provider. */
async function speakWithAi(clean: string, settings: SpeechSettings): Promise<void> {
  const res = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean.slice(0, 4000), voice: settings.aiVoice, speed: settings.rate }),
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(detail.error ?? `TTS HTTP ${res.status}`)
  }
  const blob = await res.blob()
  currentAiAudio?.pause()
  currentAiAudio = new Audio(URL.createObjectURL(blob))
  await currentAiAudio.play().catch(() => undefined)
}

function speakSentencesBrowser(clean: string, settings: SpeechSettings): void {
  const voices = window.speechSynthesis.getVoices()
  const chosen =
    (settings.browserVoiceName && voices.find((v) => v.name === settings.browserVoiceName)) ||
    pickVoice(voices)
  const sentences = splitSentences(clean).slice(0, 40)
  sentences.forEach((sentence, i) => {
    const utterance = new SpeechSynthesisUtterance(sentence)
    if (chosen) utterance.voice = chosen
    // gentle human-ish variance around the user's base rate/pitch
    utterance.rate = Math.min(2, Math.max(0.5, settings.rate + ((i % 3) - 1) * 0.02))
    utterance.pitch = Math.min(2, Math.max(0, settings.pitch + ((i % 4) - 1.5) * 0.03))
    if (i === sentences.length - 1 && sentence.length < 60) utterance.rate *= 0.96
    window.speechSynthesis.speak(utterance)
  })
}

export async function speak(text: string): Promise<void> {
  const settings = getSpeechSettings()
  if (settings.engine === 'ai') {
    try {
      await speakWithAi(cleanForSpeech(text), settings)
      return
    } catch {
      // fall through to browser engine when the AI voice is unavailable
    }
  }
  if (!('speechSynthesis' in window)) return
  const clean = cleanForSpeech(text)
  if (!clean) return
  window.speechSynthesis.cancel()
  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.onvoiceschanged = null
      speakSentencesBrowser(clean, settings)
    }
    setTimeout(() => {
      if (!window.speechSynthesis.speaking) speakSentencesBrowser(clean, settings)
    }, 150)
    return
  }
  speakSentencesBrowser(clean, settings)
}
