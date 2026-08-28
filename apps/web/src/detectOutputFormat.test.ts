import { describe, expect, it } from 'vitest'

import { detectOutputFormat } from './pages/ChatPage'

describe('detectOutputFormat', () => {
  it('detects image requests by verb + subject', () => {
    expect(detectOutputFormat('create an image of a cat')).toBe('image')
    expect(detectOutputFormat('make a logo for my app')).toBe('image')
    expect(detectOutputFormat('draw me a flowchart')).toBe('image')
    expect(detectOutputFormat('generate a poster please')).toBe('image')
  })

  it('detects animation requests', () => {
    expect(detectOutputFormat('animate a bouncing ball')).toBe('animation')
    expect(detectOutputFormat('make it an animation')).toBe('animation')
  })

  it('leaves ordinary text alone', () => {
    expect(detectOutputFormat('what is docker networking?')).toBe('text')
    expect(detectOutputFormat('imagine that we add auth later')).toBe('text')
    expect(detectOutputFormat('')).toBe('text')
  })
})