import { describe, expect, test } from 'claude-code/testing'

import { braille, formatGrowth, formatTokens, growthTrail, metaRow } from './lib'

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
  test('tokens', () => {
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(1840)).toBe('1.8k')
    expect(formatTokens(23400)).toBe('23k')
  })
  test('growth: signed, one decimal under 10 points', () => {
    expect(formatGrowth(0.62)).toBe('+0.6%')
    expect(formatGrowth(12.4)).toBe('+12%')
    expect(formatGrowth(-38.2)).toBe('-38%')
    expect(formatGrowth(-0.01)).toBe('+0.0%')
  })
})

describe('growthTrail', () => {
  test('negative growth draws as 0', () => {
    expect(growthTrail([], -38, 1)).toEqual({ past: '', now: '⠀' })
  })
  test('scales to the largest value; newest cell holds previous and current', () => {
    const t = growthTrail([2, 4], 4, 2)
    expect(Array.from(t.past + t.now)).toHaveLength(2)
    expect(t.now).toBe('⣿')
  })
})

describe('metaRow', () => {
  const meta = { thinkMs: 12_300, blocks: 3, outTok: 1840 }
  test('full row fits on a wide band', () => {
    const row = metaRow(meta, 0.62, [1, 2], 56)
    expect(text(row).startsWith('◆ 12s · 3 blk · 1.8k out   +0.6% ')).toBe(true)
    expect(row.find(s => s.text === '+0.6%')?.tone).toBe('bright')
  })
  test('growth of 10 or more is amber', () => {
    expect(metaRow(meta, 12, [], 56).find(s => s.text === '+12%')?.tone).toBe('warn')
  })
  test('drops the trail first, then the token count, then everything', () => {
    expect(text(metaRow(meta, 0.62, [], 40))).toBe('◆ 12s · 3 blk · 1.8k out   +0.6%')
    expect(text(metaRow(meta, 0.62, [], 25))).toBe('◆ 12s · 3 blk   +0.6%')
    expect(metaRow(meta, 0.62, [], 12)).toEqual([])
  })
  test('null growth shows metadata only, no trail', () => {
    expect(text(metaRow(meta, null, [3], 56))).toBe('◆ 12s · 3 blk · 1.8k out')
  })
})
