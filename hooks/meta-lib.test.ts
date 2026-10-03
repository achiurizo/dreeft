import { describe, expect, test } from 'claude-code/testing'

import { braille, formatGrowth, growthTrail, metaRow } from './lib'

const text = (segs: { text: string }[]) => segs.map(s => s.text).join('')

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
    const row = metaRow({ thinkMs: 0, blocks: 1, tools: 0, outTok: 0 }, 1, [1, null], 80)
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
