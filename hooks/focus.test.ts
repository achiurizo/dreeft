import { describe, expect, test } from 'claude-code/testing'

import { addTerms, scanThought, toolTerms, topTerms } from './focus'

describe('scanThought', () => {
  test('backticked names, file names and code identifiers count; plain words do not', () => {
    const r = scanThought('', 'Check `observe()` in hooks/register.tsx, then metaRow and turn_step. Plain words here. ')
    expect(r.terms).toEqual(['observe', 'register.tsx', 'metaRow', 'turn_step'])
  })

  test('counts a sentence that opens with an interjection', () => {
    expect(scanThought('', 'Wait, that is wrong. It reads the cache. Actually, no. Hmm, maybe.\nOh, it is the other file. ').hedges).toBe(4)
  })

  test('counts a narrated realization', () => {
    const text = 'I realize the tests came second. It turns out the pane id is qualified. On closer inspection it never advanced. I need to reconsider the denylist. I\'m realizing the engine forbids it. '
    expect(scanThought('', text).hedges).toBe(5)
  })

  test('the same words as verb or adverb are not second-guesses', () => {
    const text = 'I will wait for CI before merging. Check how the path logic actually works. The run was actually green. There is no, as far as I can tell, helper. Waiting is fine. '
    expect(scanThought('', text).hedges).toBe(0)
  })

  test('a second-guess split across pieces counts once', () => {
    const a = scanThought('', 'The offset is fine. I ')
    const b = scanThought(a.carry, 'realize it is not. Actually', a.tail)
    const c = scanThought(b.carry, ', the mark is stale. ', b.tail)
    expect([a.hedges, b.hedges, c.hedges]).toEqual([0, 1, 1])
  })

  test('a piece that starts mid-sentence is not a sentence opening', () => {
    const a = scanThought('', 'The reviewer had, ')
    expect(scanThought(a.carry, 'actually, already answered. ', a.tail).hedges).toBe(0)
  })

  test('a counted second-guess is not counted again from the tail', () => {
    const a = scanThought('', 'Wait, that is wrong. ')
    expect(a.hedges).toBe(1)
    expect(scanThought(a.carry, 'So the mark stays. ', a.tail).hedges).toBe(0)
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

  test('held text that outgrows the carry is scanned as prose, not lost', () => {
    const r = scanThought('', `a stray \` then ${'plain words '.repeat(20)}and it turns out metaRow here`)
    expect(r.terms).toEqual(['metaRow'])
    expect(r.hedges).toBe(1)
  })

  test('a code fence, however long, never turns the prose after it into names', () => {
    const fence = `\`\`\`ts\n${'const total = count + 1\n'.repeat(12)}\`\`\`\n`
    const prose = 'So `metaRow` is where the problem lives so open `rows.ts` and it does not matter finally. '
    let carry = ''
    const terms: string[] = []
    // Streamed in small pieces, as the engine hands thinking over.
    for (const piece of (fence + prose).match(/[\s\S]{1,7}/g) ?? []) {
      const r = scanThought(carry, piece)
      terms.push(...r.terms)
      carry = r.carry
    }
    expect(terms).toEqual(['metaRow', 'rows.ts'])
  })

  test('a backtick left open at the end of a line holds nothing on the next line', () => {
    expect(scanThought('', 'a stray ` here\nthen `metaRow` and more ').terms).toEqual(['metaRow'])
  })

  test('a name the band cannot draw at a known width is no term: control characters, wide characters', () => {
    expect(scanThought('', '`x\x1b[31mred` `a\rb\tc` `設定ファイル` `naïve_name` `fine` ').terms).toEqual(['fine'])
    expect(toolTerms({ file_path: '/repo/we\x07ird.ts' })).toEqual([])
  })

  test('a slash between plain words is prose; a path of three parts is code', () => {
    expect(scanThought('', 'read/write and client/server, then hooks/lib/rows and src/a.ts ').terms).toEqual(['rows', 'a.ts'])
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
