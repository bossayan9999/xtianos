import { describe, expect, it } from 'vitest'

import type { ModelInfo } from '@xtiand/shared'

import { filterModels } from './components/ModelPicker'

const MODELS: ModelInfo[] = [
  { id: '1:gpt-5.2', label: 'OpenAI · gpt-5.2', providerId: 1, kind: 'openai-compat' },
  { id: '2:claude-sonnet-4-6', label: 'Anthropic claude-sonnet-4-6', providerId: 2, kind: 'anthropic' },
  { id: '3:ollama/llama3.3', label: 'Local ollama/llama3.3', providerId: 3, kind: 'openai-compat' },
]

describe('filterModels', () => {
  it('matches on label and id, case-insensitive', () => {
    expect(filterModels(MODELS, 'claude')).toHaveLength(1)
    expect(filterModels(MODELS, 'GPT')).toHaveLength(1)
    expect(filterModels(MODELS, 'ollama')).toHaveLength(1)
  })

  it('returns everything for empty query', () => {
    expect(filterModels(MODELS, '  ')).toHaveLength(3)
  })

  it('returns nothing when no match', () => {
    expect(filterModels(MODELS, 'gemini')).toHaveLength(0)
  })
})
