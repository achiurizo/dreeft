import { describe, expect, test } from 'claude-code/testing'
import type { TurnMeta } from '../types'

import { growthOf, newTurn } from './turn'
import { bandRows, bandWidth, braille, focusRow, formatGrowth, formatSecs, growthTrail, metaRow, timelineRow, width } from './rows'

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

  test('focusRow: with no names, a second-guess count too wide to fit drops, never the leading ∴', () => {
    expect(text(focusRow([], 9999, 8))).toBe('∴ ⟲ 9999')
    expect(text(focusRow([], 12345, 8))).toBe('∴ …')
    expect(text(focusRow([], 12345, 2))).toBe('∴')
    expect(text(focusRow([], 0, 2))).toBe('∴')
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
  test('growth that draws as 10.0 is amber, in the figure and in the newest trail cell', () => {
    const row = metaRow(meta, 9.96, [], 56)
    expect(row.find(s => s.text === '+10.0%')?.tone).toBe('warn')
    expect(row.at(-1)?.tone).toBe('warn')
    const under = metaRow(meta, 9.94, [], 56)
    expect(under.find(s => s.text === '+9.9%')?.tone).toBe('bright')
    expect(under.at(-1)?.tone).toBe('bright')
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
  })

  test('bandRows: maxRows 0 draws nothing', () => {
    expect(bandRows(turn, [], ctx, 60, 0)).toEqual([])
  })

  test('bandRows: on the narrowest band a five-digit second-guess count stays inside the width', () => {
    const rows = bandRows({ ...turn, focus: [], hedges: 12345 }, [], ctx, 12, 10)
    expect(rows.map(text)[0]).toBe('∴ …    ')
    for (const row of rows) expect(width(row)).toBeLessThanOrEqual(12)
  })

  test('bandRows: a done turn shows its fixed growth and is not drawn twice in the trail', () => {
    const done = { ...turn, done: true, final: 0.6 }
    const meta = (trail: (number | null)[]) => text(bandRows(done, trail, null, 60, 1)[0] ?? [])
    expect(meta([5, 0.6])).toBe(text(bandRows(turn, [5], ctx, 60, 1)[0] ?? []))
    expect(meta([5, 0.6])).toContain('+0.6%')
  })

  test('bandRows: a compaction after a done turn does not draw the turn twice', () => {
    const done = { ...turn, done: true, final: 0.6 }
    const meta = (trail: (number | null)[]) => text(bandRows(done, trail, null, 60, 1)[0] ?? [])
    expect(meta([5, 0.6, null])).toBe(meta([5, 0.6]))
    expect(meta([0.6, null])).toBe(meta([0.6]))
    // A compaction during the turn came before its growth landed: still marked.
    expect(meta([5, null, 0.6])).toContain('↓')
  })
})

describe('nudges', () => {
  /** A 10s turn: thinking for 4s, then tools. */
  const spans = [{ phase: 'think' as const, at: 0 }, { phase: 'tool' as const, at: 4000 }]
  const meta = { thinkMs: 12_300, blocks: 3, tools: 4 }

  test('timelineRow: a fired nudge marks the second it fired, one cell wide, in amber', () => {
    const row = timelineRow(spans, 0, 10_000, 60, [6200])
    expect(text(row).startsWith('▀▀▀▀▄▄▲▄▄▄▕')).toBe(true)
    expect(row.filter(s => s.tone === 'warn')).toEqual([{ text: '▲', tone: 'warn' }])
    expect(width(row)).toBe(width(timelineRow(spans, 0, 10_000, 60)))
  })

  test('timelineRow: with no nudge the row is what it was', () => {
    expect(timelineRow(spans, 0, 10_000, 60, [])).toEqual(timelineRow(spans, 0, 10_000, 60))
  })

  test('timelineRow: a nudge at the turn\'s last instant marks the last cell, not one past it', () => {
    expect(text(timelineRow(spans, 0, 10_000, 60, [10_000])).startsWith('▀▀▀▀▄▄▄▄▄▲▕')).toBe(true)
  })

  test('timelineRow: a nudge with a clock time outside the turn stays inside the strip', () => {
    expect(text(timelineRow(spans, 0, 10_000, 60, [-5000, 99_000])).startsWith('▲▀▀▀▄▄▄▄▄▲▕')).toBe(true)
  })

  test('timelineRow: the mark survives compression, in the cell that holds its second', () => {
    // 100s on a 12-cell band: 11 strip cells of 10s each, and the nudge at 57s is in the sixth.
    const long = [{ phase: 'think' as const, at: 0 }, { phase: 'tool' as const, at: 40_000 }]
    const row = timelineRow(long, 0, 100_000, 12, [57_000])
    expect(text(row)).toBe('▀▀▀▀▄▲▄▄▄▄▕')
    expect(row.find(s => s.text === '▲')?.tone).toBe('warn')
    expect(width(row)).toBeLessThanOrEqual(12)
  })

  test('timelineRow: two nudges in one compressed cell draw one mark', () => {
    const long = [{ phase: 'tool' as const, at: 0 }]
    expect(text(timelineRow(long, 0, 100_000, 12, [51_000, 58_000]))).toBe('▄▄▄▄▄▲▄▄▄▄▕')
  })

  test('metaRow: fired nudges are counted in amber after the tool count', () => {
    const row = metaRow(meta, 12, [1, 2], 60, 1)
    expect(text(row).startsWith('◆ 12s · 3 blk · 4 tools · ▲ 1   +12% ')).toBe(true)
    expect(row).toContainEqual({ text: '▲ 1', tone: 'warn' })
  })

  test('metaRow: with no nudge the row is what it was', () => {
    for (const max of [12, 25, 40, 60]) expect(metaRow(meta, 12, [1, 2], max, 0)).toEqual(metaRow(meta, 12, [1, 2], max))
    expect(metaRow(meta, null, [], 60, 0)).toEqual(metaRow(meta, null, [], 60))
  })

  test('metaRow: drops the tool count, then the trail, then the nudge count, then everything', () => {
    expect(text(metaRow(meta, 12, [], 47, 2))).toMatch(/^◆ 12s · 3 blk · 4 tools · ▲ 2   \+12% \S+$/)
    expect(text(metaRow(meta, 12, [], 46, 2))).toMatch(/^◆ 12s · 3 blk · ▲ 2   \+12% \S+$/)
    expect(text(metaRow(meta, 12, [], 37, 2))).toMatch(/^◆ 12s · 3 blk · ▲ 2   \+12% \S+$/)
    expect(text(metaRow(meta, 12, [], 36, 2))).toBe('◆ 12s · 3 blk · ▲ 2   +12%')
    expect(text(metaRow(meta, 12, [], 26, 2))).toBe('◆ 12s · 3 blk · ▲ 2   +12%')
    expect(text(metaRow(meta, 12, [], 25, 2))).toBe('◆ 12s · 3 blk   +12%')
    expect(text(metaRow(meta, 12, [], 20, 2))).toBe('◆ 12s · 3 blk   +12%')
    expect(metaRow(meta, 12, [], 19, 2)).toEqual([])
  })

  test('metaRow: every width from 0 up fits, nudge count or not', () => {
    for (let max = 0; max <= 60; max++) expect(width(metaRow(meta, 12, [3, null, 9], max, 2))).toBeLessThanOrEqual(max)
  })

  test('metaRow: with growth unmeasured the nudge count drops after the tool count', () => {
    expect(text(metaRow(meta, null, [], 60, 1))).toBe('◆ 12s · 3 blk · 4 tools · ▲ 1')
    expect(text(metaRow(meta, null, [], 28, 1))).toBe('◆ 12s · 3 blk · ▲ 1')
    expect(text(metaRow(meta, null, [], 18, 1))).toBe('◆ 12s · 3 blk')
  })

  /** A turn at +12 points that fired one nudge at 1s. */
  const nudged: TurnMeta = { ...newTurn(0, 100_000, 1_000_000), now: 2000, spans: [{ phase: 'tool', at: 0 }], nudges: [1000], triggers: 1 }
  const grown = { tokens: 220_000, window: 1_000_000, lastInput: null }

  test('bandRows: a nudged turn shows the mark in the timeline and the count in the meta row', () => {
    const rows = bandRows(nudged, [], grown, 60, 10).map(text)
    expect(rows[1]?.startsWith('▄▲▕')).toBe(true)
    expect(rows[2]?.startsWith('◆ 0s · 0 blk · 0 tools · ▲ 1   +12%')).toBe(true)
  })

  test('bandRows: on a 12-cell band a nudged turn keeps the mark and every row fits', () => {
    const rows = bandRows(nudged, [], grown, 12, 10)
    expect(rows.map(text)).toEqual(['∴ …    ', '▄▲▕'])
    for (const row of rows) expect(width(row)).toBeLessThanOrEqual(12)
  })

  test('bandRows: a turn written before nudges were kept draws as a turn without any', () => {
    const { nudges: _nudges, triggers: _triggers, ...old } = nudged
    expect(bandRows(old, [], grown, 60, 10)).toEqual(bandRows({ ...nudged, nudges: [] }, [], grown, 60, 10))
  })
})
