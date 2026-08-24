import { describe, expect, it } from 'vitest'
import { cleanForSpeech, pickVoice, splitSentences } from './lib/speech'

describe('cleanForSpeech', () => {
  it('removes code blocks, links, emojis and markdown', () => {
    const dirty = '## Hey 🎉\n\n```js\nconst x = 1\n```\nCheck [docs](http://x.y) and **bold**.'
    const clean = cleanForSpeech(dirty)
    expect(clean).not.toMatch(/```/)
    expect(clean).not.toContain('[')
    expect(clean).not.toContain('**')
  })

  it('keeps plain sentences intact', () => {
    expect(cleanForSpeech('Hello there. General Kenobi!')).toBe('Hello there. General Kenobi!')
  })
})

describe('splitSentences', () => {
  it('splits on sentence boundaries', () => {
    expect(splitSentences('One. Two? Three!')).toEqual(['One.', 'Two?', 'Three!'])
  })

  it('keeps decimals together', () => {
    expect(splitSentences('Pi is 3.14 exactly')).toEqual(['Pi is 3.14 exactly'])
  })
})

describe('pickVoice', () => {
  const mk = (name: string, lang = 'en-US'): SpeechSynthesisVoice =>
    ({ name, lang, default: false, voiceURI: name }) as unknown as SpeechSynthesisVoice

  it('prefers known natural voices', () => {
    const voices = [mk('Daniel'), mk('Microsoft Aria Online (Natural)')]
    expect(pickVoice(voices)?.name).toContain('Aria')
  })

  it('falls back to first english voice', () => {
    expect(pickVoice([mk('Weird Bot', 'de-DE'), mk('Fred')])?.name).toBe('Fred')
  })
})
