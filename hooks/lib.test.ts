import { describe, expect, test } from 'claude-code/testing'
import type { TurnMeta } from '../types'

import { addTerms, bandRows, bandWidth, enterPhase, focusRow, formatSecs, growthOf, newTurn, phaseOfMode, phaseTotals, reduceChunk, scanThought, timelineCells, timelineRow, toolTerms, topTerms } from './lib'

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

  test('timelineCells: one cell per second', () => {
    expect(timelineCells(spans, 0, 11_000, 40).join(',')).toBe(
      'wait,think,think,think,tool,tool,tool,tool,tool,write,write',
    )
  })

  test('timelineCells: a short burst still marks its cell; think outranks tool, write and wait', () => {
    const burst = [
      { phase: 'wait' as const, at: 0 },
      { phase: 'think' as const, at: 1200 },
      { phase: 'wait' as const, at: 1500 },
      { phase: 'tool' as const, at: 2100 },
      { phase: 'write' as const, at: 2300 },
    ]
    expect(timelineCells(burst, 0, 3000, 40).join(',')).toBe('wait,think,tool')
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

  test('timelineRow: waiting is blank, and the end cap shows where the strip stops', () => {
    const spans = [
      { phase: 'wait' as const, at: 0 },
      { phase: 'think' as const, at: 1000 },
      { phase: 'wait' as const, at: 2000 },
    ]
    expect(text(timelineRow(spans, 0, 3000, 80))).toBe(' ▀ ▕  think 1s')
  })

  test('timelineRow: a glyph per cell, then totals per phase', () => {
    const spans = [
      { phase: 'think' as const, at: 0 },
      { phase: 'tool' as const, at: 2000 },
      { phase: 'write' as const, at: 3000 },
    ]
    const row = timelineRow(spans, 0, 4000, 80)
    expect(text(row)).toBe('▀▀▄█▕  think 2s · tools 1s · write 1s')
    expect(row.find(s => s.text === '▀▀')?.tone).toBe('think')
    expect(row.find(s => s.text === '▄')?.tone).toBe('tool')
  })

  test('timelineRow: drops the totals when they would leave under 8 cells', () => {
    const spans = [
      { phase: 'think' as const, at: 0 },
      { phase: 'tool' as const, at: 1000 },
    ]
    expect(text(timelineRow(spans, 0, 2000, 20))).toBe('▀▄▕')
  })

  test('timelineRow: zero-time phases are left out of the totals', () => {
    expect(text(timelineRow([{ phase: 'think', at: 0 }], 0, 1000, 80))).toBe('▀▕  think 1s')
  })

  test('timelineRow: a phase under half a second reads <1s instead of vanishing', () => {
    const spans = [
      { phase: 'tool' as const, at: 0 },
      { phase: 'write' as const, at: 2000 },
    ]
    expect(text(timelineRow(spans, 0, 2300, 80))).toBe('▄▄█▕  tools 2s · write <1s')
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

  test('a think span opened earlier (by the spinner) does not stop the first chunk counting a block', () => {
    let t = enterPhase(t0, 'think', 50)
    t = reduceChunk(t, { kind: 'thinking', index: 0, text: 'a ' }, 100)
    expect(t.blocks).toBe(1)
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

  test('stop moves the clock on and changes no phase', () => {
    const t = reduceChunk(
      t0,
      { kind: 'stop', stopReason: 'end_turn', usage: { model: 'm', input_tokens: 1, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      100,
    )
    expect(t).toMatchObject({ now: 100, spans: t0.spans, lastChunk: 'stop' })
  })
})

describe('phaseOfMode', () => {
  test('maps every spinner mode to a phase', () => {
    expect((['requesting', 'thinking', 'responding', 'tool-input', 'tool-use'] as const).map(m => phaseOfMode(m))).toEqual(['wait', 'think', 'write', 'tool', 'tool'])
  })
})

describe('band', () => {
  /** A turn that started at 100k of a 1M window, thought for 2s and named `metaRow` twice. */
  const turn: TurnMeta = {
    ...newTurn(0, 100_000, 1_000_000),
    now: 2000,
    spans: [{ phase: 'think', at: 0 }],
    focus: [{ t: 'metaRow', n: 2 }],
    blocks: 1,
  }
  const ctx = { tokens: 106_000, window: 1_000_000, lastInput: null }

  test('bandWidth: six tenths of the body, capped at 84, nothing under 12', () => {
    expect(bandWidth(100)).toBe(60)
    expect(bandWidth(300)).toBe(84)
    expect(bandWidth(20)).toBe(12)
    expect(bandWidth(19)).toBeNull()
  })

  test('growthOf: points of the window since step 0; null without a start or a window', () => {
    expect(growthOf(turn, ctx)).toBe(0.6)
    expect(growthOf(turn, null)).toBeNull()
    expect(growthOf({ ...turn, startTokens: null }, ctx)).toBeNull()
    expect(growthOf({ ...turn, window: 0 }, ctx)).toBeNull()
  })

  test('bandRows: focus, timeline, meta; the top row ends in the blank corner', () => {
    const rows = bandRows(turn, [], ctx, 60, 10).map(text)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBe('∴ metaRow ×2    ')
    expect(rows[1]?.startsWith('▀▀')).toBe(true)
    expect(rows[2]?.startsWith('◆ 2s · 1 blk · 0 tools   +0.6%')).toBe(true)
  })

  test('bandRows: a short band keeps the bottom rows', () => {
    expect(bandRows(turn, [], ctx, 60, 2).map(r => text(r).slice(0, 1))).toEqual(['▀', '◆'])
    expect(bandRows(turn, [], ctx, 60, 0).map(r => text(r).slice(0, 1))).toEqual(['◆'])
  })

  test('bandRows: a done turn shows its fixed growth and is not drawn twice in the trail', () => {
    const done = { ...turn, done: true, final: 0.6 }
    const meta = (trail: (number | null)[]) => text(bandRows(done, trail, null, 60, 1)[0] ?? [])
    expect(meta([5, 0.6])).toBe(text(bandRows(turn, [5], ctx, 60, 1)[0] ?? []))
    expect(meta([5, 0.6])).toContain('+0.6%')
  })
})
