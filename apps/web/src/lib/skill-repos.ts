export interface KnownSkillRepo {
  name: string
  description: string
  url: string
}

/** Curated catalog of popular SKILL.md packages, searchable from the install combobox. */
export const knownSkillRepos: KnownSkillRepo[] = [
  {
    name: 'anthropics/skills',
    description: 'Official Agent Skills library — docx/pdf/pptx/xlsx, canvas design, web-app testing, skill-creator',
    url: 'https://github.com/anthropics/skills',
  },
  {
    name: 'obra/superpowers',
    description: '20+ battle-tested dev skills: test-driven-development, systematic-debugging, writing-plans',
    url: 'https://github.com/obra/superpowers',
  },
  {
    name: 'obra/superpowers-skills',
    description: 'Community-editable skills for the superpowers ecosystem',
    url: 'https://github.com/obra/superpowers-skills',
  },
  {
    name: 'expo/skills',
    description: "Expo team's skills for building React Native / Expo apps",
    url: 'https://github.com/expo/skills',
  },
  {
    name: 'trailofbits/skills',
    description: 'Security-focused skills: static analysis, vulnerability detection, secure code review',
    url: 'https://github.com/trailofbits/skills',
  },
  {
    name: 'travisvn/awesome-claude-skills',
    description: 'Curated directory of awesome Claude skills, resources, and tools',
    url: 'https://github.com/travisvn/awesome-claude-skills',
  },
  {
    name: 'ComposioHQ/awesome-claude-skills',
    description: '1000+ production-ready Claude skills for coding agents',
    url: 'https://github.com/ComposioHQ/awesome-claude-skills',
  },
]

export function searchSkillRepos(query: string): KnownSkillRepo[] {
  const q = query.trim().toLowerCase()
  if (!q) return knownSkillRepos
  return knownSkillRepos.filter(
    (r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
  )
}