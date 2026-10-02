import { describe, expect, test } from 'claude-code/testing'
import type { TurnMeta } from '../types'

import { addTerms, focusRow, formatSecs, newTurn, phaseTotals, reduceChunk, scanThought, timelineCells, timelineRow, topTerms } from './lib'

const text = (segs: { text: string }[]) => segs.map(s => s.text).join('')

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

describe('focus terms', () => {
  test('addTerms counts and moves a seen term to the end', () => {
    expect(addTerms([{ t: 'a', n: 1 }, { t: 'b', n: 1 }], ['a', 'c'])).toEqual([
      { t: 'b', n: 1 },
      { t: 'a', n: 2 },
      { t: 'c', n: 1 },
    ])
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

describe('phases', () => {
  const spans = [
    { phase: 'wait' as const, at: 0 },
    { phase: 'think' as const, at: 1000 },
    { phase: 'tool' as const, at: 4000 },
    { phase: 'write' as const, at: 9000 },
  ]

  test('phaseTotals sums each phase up to the end time', () => {
    expect(phaseTotals(spans, 11_000)).toEqual({ wait: 1000, think: 3000, tool: 5000, write: 2000 })
  })

  test('timelineCells: one cell per second, sampled mid-cell', () => {
    expect(timelineCells(spans, 0, 11_000, 40).join(',')).toBe(
      'wait,think,think,think,tool,tool,tool,tool,tool,write,write',
    )
  })

  test('timelineCells: a long turn compresses to fit, whole seconds per cell', () => {
    const cells = timelineCells(spans, 0, 11_000, 4)
    expect(cells.length).toBeLessThanOrEqual(4)
    expect(cells[cells.length - 1]).toBe('write')
  })

  test('timelineCells: a turn under a second still has one cell', () => {
    expect(timelineCells([{ phase: 'wait', at: 0 }], 0, 0, 40)).toEqual(['wait'])
  })

  test('formatSecs', () => {
    expect(formatSecs(400)).toBe('0s')
    expect(formatSecs(16_400)).toBe('16s')
    expect(formatSecs(124_000)).toBe('2m4s')
  })
})

describe('rows', () => {
  test('focusRow: terms with counts, then second-guesses in amber', () => {
    const row = focusRow([{ t: 'register.tsx', n: 3 }, { t: 'metaRow', n: 2 }], 2, 80)
    expect(text(row)).toBe('∴ register.tsx ×3 · metaRow ×2   ⟲ 2')
    expect(row.find(s => s.text === '2')?.tone).toBe('warn')
  })

  test('focusRow: drops terms from the end to fit, never the leading ∴', () => {
    const row = focusRow([{ t: 'register.tsx', n: 3 }, { t: 'metaRow', n: 2 }], 0, 20)
    expect(text(row)).toBe('∴ register.tsx ×3')
  })

  test('focusRow: nothing yet shows a placeholder', () => {
    expect(text(focusRow([], 0, 80))).toBe('∴ …')
  })

  test('timelineRow: a glyph per cell, then totals per phase', () => {
    const spans = [
      { phase: 'think' as const, at: 0 },
      { phase: 'tool' as const, at: 2000 },
      { phase: 'write' as const, at: 3000 },
    ]
    const row = timelineRow(spans, 0, 4000, 80)
    expect(text(row)).toBe('▒▒░█  think 2s · tools 1s · write 1s')
    expect(row.find(s => s.text === '▒▒')?.tone).toBe('think')
    expect(row.find(s => s.text === '░')?.tone).toBe('tool')
  })

  test('timelineRow: drops the totals when they would leave under 8 cells', () => {
    const spans = [
      { phase: 'think' as const, at: 0 },
      { phase: 'tool' as const, at: 1000 },
    ]
    expect(text(timelineRow(spans, 0, 2000, 20))).toBe('▒░')
  })

  test('timelineRow: zero-time phases are left out of the totals', () => {
    expect(text(timelineRow([{ phase: 'think', at: 0 }], 0, 1000, 80))).toBe('▒  think 1s')
  })
})

describe('reduceChunk', () => {
  const t0: TurnMeta = newTurn(0, null, 0)

  test('thinking opens a think span and a block; more thinking extends it', () => {
    let t = reduceChunk(t0, { kind: 'thinking', index: 0, text: 'a ' }, 1000)
    t = reduceChunk(t, { kind: 'thinking', index: 0, text: 'b ' }, 2000)
    expect(t.spans).toEqual([
      { phase: 'wait', at: 0 },
      { phase: 'think', at: 1000 },
    ])
    expect(t.blocks).toBe(1)
    expect(t.now).toBe(2000)
  })

  test('a tool chunk opens a tool span and counts the tool', () => {
    const t = reduceChunk(t0, { kind: 'tool', index: 1, id: 'x', name: 'Bash' }, 500)
    expect(t.tools).toBe(1)
    expect(t.spans.at(-1)).toEqual({ phase: 'tool', at: 500 })
  })

  test('text opens a write span; thinking after it is a new block', () => {
    let t = reduceChunk(t0, { kind: 'thinking', index: 0, text: 'a ' }, 100)
    t = reduceChunk(t, { kind: 'text', index: 1, text: 'ok' }, 200)
    t = reduceChunk(t, { kind: 'thinking', index: 2, text: 'b ' }, 300)
    expect(t.spans.map(s => s.phase)).toEqual(['wait', 'think', 'write', 'think'])
    expect(t.blocks).toBe(2)
  })

  test('thinking text feeds focus and second-guesses', () => {
    const t = reduceChunk(t0, { kind: 'thinking', index: 0, text: 'Wait, `metaRow` again. ' }, 100)
    expect(t.focus).toEqual([{ t: 'metaRow', n: 1 }])
    expect(t.hedges).toBe(1)
  })

  test('an empty thinking chunk still counts as thinking, with nothing to scan', () => {
    const t = reduceChunk(t0, { kind: 'thinking', index: 0, text: '' }, 100)
    expect(t.spans.at(-1)).toEqual({ phase: 'think', at: 100 })
    expect(t.blocks).toBe(1)
    expect(t.focus).toEqual([])
  })

  test("a block's last word counts once the block ends", () => {
    let t = reduceChunk(t0, { kind: 'thinking', index: 0, text: 'then `metaRow`' }, 100)
    expect(t.focus).toEqual([])
    t = reduceChunk(t, { kind: 'tool', index: 1, id: 'x', name: 'Read' }, 200)
    expect(t.focus).toEqual([{ t: 'metaRow', n: 1 }])
  })

  test('stop usage adds output tokens', () => {
    const t = reduceChunk(
      t0,
      { kind: 'stop', stopReason: 'end_turn', usage: { model: 'm', input_tokens: 1, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      100,
    )
    expect(t.outTok).toBe(40)
  })
})
