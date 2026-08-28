import { describe, expect, it } from 'vitest'

import { searchSkillRepos } from './lib/skill-repos'

describe('searchSkillRepos', () => {
  it('matches on name and description, case-insensitive', () => {
    expect(searchSkillRepos('anthropics')).toHaveLength(1)
    expect(searchSkillRepos('SUPERPOWERS')).toHaveLength(2)
    expect(searchSkillRepos('debugging')).toHaveLength(1)
  })

  it('returns everything for empty query', () => {
    expect(searchSkillRepos('  ').length).toBeGreaterThan(3)
  })

  it('returns nothing when no match', () => {
    expect(searchSkillRepos('zzz-nonexistent')).toHaveLength(0)
  })
})