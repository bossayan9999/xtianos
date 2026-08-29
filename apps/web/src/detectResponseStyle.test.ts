import { describe, expect, it } from 'vitest'

import { detectResponseStyle } from './pages/ChatPage'

describe('detectResponseStyle', () => {
  it('picks deep for reasoning/analysis questions', () => {
    expect(detectResponseStyle('why is this happening?')).toBe('deep')
    expect(detectResponseStyle('explain the tradeoffs and recommend the best option')).toBe('deep')
    expect(detectResponseStyle('analyze the pros and cons of moving to postgres')).toBe('deep')
    expect(detectResponseStyle('should I use docker or podman? consider the risks')).toBe('deep')
    expect(detectResponseStyle('compare the two architectures and decide which is better')).toBe('deep')
    expect(detectResponseStyle('debug why the container keeps restarting')).toBe('deep')
  })

  it('picks speed for terse/urgent messages', () => {
    expect(detectResponseStyle('hi')).toBe('speed')
    expect(detectResponseStyle('what is 2+2?')).toBe('speed')
    expect(detectResponseStyle('give me a quick answer')).toBe('speed')
    expect(detectResponseStyle('tldr: is it safe?')).toBe('speed')
    expect(detectResponseStyle('summarize this in one sentence')).toBe('speed')
    expect(detectResponseStyle('asap, short').length).toBeGreaterThan(0)
  })

  it('picks structured for lists, steps and formatted output', () => {
    expect(detectResponseStyle('list the top 5 docker best practices')).toBe('structured')
    expect(detectResponseStyle('give me a step-by-step guide on nginx')).toBe('structured')
    expect(detectResponseStyle('breakdown of the weekend plan as a checklist')).toBe('structured')
    expect(detectResponseStyle('summarize our storage setup with a table')).toBe('structured')
    expect(detectResponseStyle('how do I set up a home backup schedule?')).toBe('structured')
  })

  it('leaves ordinary questions balanced', () => {
    expect(detectResponseStyle('tell me about your plans for the weekend')).toBe('balanced')
    expect(detectResponseStyle('what did we do so far?')).toBe('balanced')
    expect(detectResponseStyle('')).toBe('balanced')
  })
})