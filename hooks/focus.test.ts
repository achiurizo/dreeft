import { describe, expect, test } from 'claude-code/testing'

import { addTerms, scanThought, toolTerms, topTerms } from './focus'

describe('scanThought', () => {
  test('backticked names, file names and code identifiers count; plain words do not', () => {
    const r = scanThought('', 'Check `observe()` in hooks/register.tsx, then metaRow and turn_step. Plain words here. ')
    expect(r.terms).toEqual(['observe', 'register.tsx', 'metaRow', 'turn_step'])
  })

  test('counts second-guesses: wait, actually, hmm', () => {
    expect(scanThought('', 'Wait, that is wrong. Actually no. Hmm, maybe. Waiting is fine. ').hedges).toBe(3)
  })

  test('holds back a trailing partial word or open backtick for the next piece', () => {
    const a = scanThought('', 'look at `meta')
    expect(a.terms).toEqual([])
    expect(a.carry).toBe('`meta')
    const b = scanThought(a.carry, 'Row` now ')
    expect(b.terms).toEqual(['metaRow'])
    expect(b.carry).toBe('')
  })

  test('a long unbroken carry is dropped rather than kept forever', () => {
    expect(scanThought('', '`' + 'x'.repeat(300)).carry).toBe('')
  })

  test('terms shorter than 3 or longer than 40 characters are skipped', () => {
    expect(scanThought('', '`ab` `' + 'a'.repeat(41) + '` `fine` ').terms).toEqual(['fine'])
  })
})

describe('toolTerms', () => {
  test('a file a tool reads or edits counts by its name', () => {
    expect(toolTerms({ file_path: '/repo/hooks/register.tsx', limit: 15 })).toEqual(['register.tsx'])
    expect(toolTerms({ notebook_path: 'nb/analysis.ipynb' })).toEqual(['analysis.ipynb'])
  })

  test('a search counts its code names, not its plain words', () => {
    expect(toolTerms({ pattern: 'braille|growthTrail', path: '/repo' })).toEqual(['growthTrail'])
  })

  test('a command counts only the file names in it, not directories or flags', () => {
    expect(toolTerms({ command: 'cd /Users/me/code/repo && cat hooks/lib.ts README.md | grep -n x_y' })).toEqual(['lib.ts', 'README.md'])
  })

  test('other arguments and non-object input count nothing', () => {
    expect(toolTerms({ description: 'Read `metaRow` in lib.ts', prompt: 'look at register.tsx' })).toEqual([])
    expect(toolTerms(null)).toEqual([])
    expect(toolTerms('lib.ts')).toEqual([])
    expect(toolTerms({ file_path: 42 })).toEqual([])
  })
})

describe('focus terms', () => {
  test('addTerms counts and moves a seen term to the end', () => {
    expect(addTerms([{ t: 'a', n: 1 }, { t: 'b', n: 1 }], ['a', 'c'])).toEqual([
      { t: 'b', n: 1 },
      { t: 'a', n: 2 },
      { t: 'c', n: 1 },
    ])
  })

  test('topTerms: a name mentioned once is not focus yet', () => {
    expect(topTerms([{ t: 'once', n: 1 }, { t: 'twice', n: 2 }], 3)).toEqual([{ t: 'twice', n: 2 }])
  })

  test('topTerms: highest count first, the most recent first on a tie', () => {
    const focus = [
      { t: 'old', n: 2 },
      { t: 'x', n: 1 },
      { t: 'new', n: 2 },
    ]
    expect(topTerms(focus, 2)).toEqual([
      { t: 'new', n: 2 },
      { t: 'old', n: 2 },
    ])
  })
})
