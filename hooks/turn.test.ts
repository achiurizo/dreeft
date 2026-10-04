import { describe, expect, test } from 'claude-code/testing'
import type { TurnMeta } from '../types'

import { enterPhase, newTurn, phaseOfMode, phaseTotals, reduceChunk, timelineCells } from './turn'
import { stop } from './testkit'

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
      stop('end_turn', 1, 40),
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
