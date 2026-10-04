import { describe, expect, test } from 'claude-code/testing'
import type { TurnMeta } from '../types'

import { growthOf, newTurn } from './turn'
import { bandRows, bandWidth, braille, focusRow, formatGrowth, formatSecs, growthTrail, metaRow, timelineRow } from './rows'

const text = (segs: { text: string }[]) => segs.map(s => s.text).join('')

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

describe('braille', () => {
  test('empty pair is the blank cell, full pair is all eight dots', () => {
    expect(braille([0, 0])).toBe('⠀')
    expect(braille([100, 100])).toBe('⣿')
  })
  test('left column then right column, bottom up', () => {
    expect(braille([25, 0])).toBe('⡀')
    expect(braille([0, 25])).toBe('⢀')
  })
  test('odd length pads the last right column with 0', () => {
    expect(braille([100])).toBe('⡇')
  })
})

describe('formatters', () => {
  test('growth: signed, one decimal under 10 points', () => {
    expect(formatGrowth(0.62)).toBe('+0.6%')
    expect(formatGrowth(12.4)).toBe('+12%')
    expect(formatGrowth(-38.2)).toBe('-38%')
    expect(formatGrowth(-0.01)).toBe('+0.0%')
  })

  test('formatSecs', () => {
    expect(formatSecs(400)).toBe('0s')
    expect(formatSecs(16_400)).toBe('16s')
    expect(formatSecs(124_000)).toBe('2m4s')
  })
})

describe('growthTrail', () => {
  const flat = (t: ReturnType<typeof growthTrail>) => ({ past: t.past.map(s => s.text).join(''), now: t.now })
  test('negative growth draws as a zero turn: one dot, never blank', () => {
    expect(flat(growthTrail([], -38, 1))).toEqual({ past: '', now: '\u2880' })
  })
  test('small growth values still draw: scale to the largest value shown', () => {
    expect(flat(growthTrail([0.2, 0.4], 0.3, 2))).toEqual({ past: '\u28a0', now: '\u28f7' })
  })
  test('a real zero-growth turn shows one dot; padding stays blank', () => {
    expect(flat(growthTrail([0], 0, 2))).toEqual({ past: '\u2800', now: '\u28c0' })
  })
  test('scales to the largest value; newest cell holds previous and current', () => {
    const t = flat(growthTrail([2, 4], 4, 2))
    expect(Array.from(t.past + t.now)).toHaveLength(2)
    expect(t.now).toBe('⣿')
  })
  test('a compaction draws an amber ↓ before the cell it landed in', () => {
    const t = growthTrail([2, null, 4], 4, 2)
    expect(flat(t)).toEqual({ past: '⢠↓', now: '⣿' })
    expect(t.past.at(-1)).toEqual({ text: '↓', tone: 'warn' })
  })
  test('a compaction during the current turn marks the newest cell', () => {
    expect(flat(growthTrail([1, 1, null], -40, 2)).past.endsWith('↓')).toBe(true)
  })
  test('a compaction scrolled out of view draws nothing', () => {
    expect(flat(growthTrail([null, 1, 1, 1, 1], 1, 2)).past.includes('↓')).toBe(false)
  })
  test('the meta row shows the mark in amber', () => {
    const row = metaRow({ thinkMs: 0, blocks: 1, tools: 0 }, 1, [1, null], 80)
    expect(row).toContainEqual({ text: '↓', tone: 'warn' })
  })
})

describe('metaRow', () => {
  const meta = { thinkMs: 12_300, blocks: 3, tools: 4 }
  test('full row fits on a wide band', () => {
    const row = metaRow(meta, 0.62, [1, 2], 56)
    expect(text(row).startsWith('◆ 12s · 3 blk · 4 tools   +0.6% ')).toBe(true)
    expect(row.find(s => s.text === '+0.6%')?.tone).toBe('bright')
  })
  test('one tool is singular', () => {
    expect(text(metaRow({ ...meta, tools: 1 }, null, [], 56))).toBe('◆ 12s · 3 blk · 1 tool')
  })
  test('growth of 10 or more is amber', () => {
    expect(metaRow(meta, 12, [], 56).find(s => s.text === '+12%')?.tone).toBe('warn')
  })
  test('drops the tool count first, then the trail, then everything', () => {
    expect(text(metaRow(meta, 0.62, [], 40))).not.toContain('tools')
    expect(text(metaRow(meta, 0.62, [], 40))).toMatch(/\+0\.6% \S/)
    expect(text(metaRow(meta, 0.62, [], 25))).toBe('◆ 12s · 3 blk   +0.6%')
    expect(metaRow(meta, 0.62, [], 12)).toEqual([])
  })
  test('null growth shows metadata only, no trail', () => {
    expect(text(metaRow(meta, null, [3], 56))).toBe('◆ 12s · 3 blk · 4 tools')
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
