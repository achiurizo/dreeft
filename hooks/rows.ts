// Rows: the turn drawn as runs of toned text, and the band they make together.

import type { Ctx, Phase, Span, Term, Trail, TurnMeta } from '../types'
import { topTerms } from './focus'
import { growthOf, phaseTotals, timelineCells } from './turn'

/** How a segment is drawn: `faint` and `dim` recede, `warn` is amber, `think` and `tool` follow the palette. */
export type Tone = 'faint' | 'dim' | 'bright' | 'warn' | 'think' | 'tool'
/** A run of text in one tone; a row is a list of these. */
export type Seg = { text: string; tone: Tone }
/** The turn figures the meta row shows; `thinkMs` in milliseconds. */
export type Meta = { thinkMs: number; blocks: number; tools: number }

/** The terminal cells a row takes: every character the band draws is one cell wide (terms are ASCII). */
export const width = (segs: Seg[]) => segs.reduce((n, s) => n + Array.from(s.text).length, 0)

/** Milliseconds as whole seconds: `42s`, or `1m5s` from a minute up. */
export function formatSecs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

/** Half-block lanes: thinking on top, tools below, writing fills both, waiting leaves the cell blank. */
const GLYPH: Record<Phase, string> = { wait: ' ', think: '▀', tool: '▄', write: '█' }
/** Closes the strip, so trailing blank (waiting) cells still read as time. */
const CAP = '▕'
const TONE: Record<Phase, Tone> = { wait: 'faint', think: 'think', tool: 'tool', write: 'bright' }
const TOTALS: [Phase, string][] = [
  ['think', 'think'],
  ['tool', 'tools'],
  ['write', 'write'],
]
const MIN_STRIP = 8

/**
 * The turn as a strip of phase cells and its cap, then time per phase; the totals drop when they leave under 8 cells.
 * @param start - clock time of the turn's start, in milliseconds
 * @param end - clock time the strip runs to, in milliseconds
 * @param max - width in terminal cells
 */
export function timelineRow(spans: Span[], start: number, end: number, max: number): Seg[] {
  const sums = phaseTotals(spans, end)
  const totals: Seg[] = []
  for (const [phase, label] of TOTALS) {
    if (sums[phase] === 0) continue
    const time = sums[phase] < 500 ? '<1s' : formatSecs(sums[phase])
    totals.push({ text: totals.length === 0 ? '  ' : ' · ', tone: 'dim' }, { text: `${label} ${time}`, tone: TONE[phase] })
  }
  const room = max - width(totals)
  const fits = room >= MIN_STRIP
  const cells = timelineCells(spans, start, end, (fits ? room : max) - CAP.length)
  const strip: Seg[] = []
  for (const c of cells) {
    const last = strip.at(-1)
    if (last && last.tone === TONE[c]) last.text += GLYPH[c]
    else strip.push({ text: GLYPH[c], tone: TONE[c] })
  }
  strip.push({ text: CAP, tone: 'dim' })
  return fits ? [...strip, ...totals] : strip
}

/**
 * `∴` then the top terms with counts, then second-guesses; terms drop from the end to fit, then
 * the second-guesses, then the `…` placeholder; the leading `∴` always stays.
 * @param max - width in terminal cells
 */
export function focusRow(top: Term[], hedges: number, max: number): Seg[] {
  const tail: Seg[] = hedges > 0 ? [{ text: '   ⟲ ', tone: 'dim' }, { text: String(hedges), tone: 'warn' }] : []
  for (let k = top.length; k > 0; k--) {
    const terms = top.slice(0, k).flatMap((f, i): Seg[] => [
      ...(i > 0 ? [{ text: ' · ', tone: 'dim' as Tone }] : []),
      { text: f.t, tone: 'bright' },
      { text: ` ×${f.n}`, tone: 'dim' },
    ])
    const row: Seg[] = [{ text: '∴ ', tone: 'dim' }, ...terms, ...tail]
    if (width(row) <= max) return row
  }
  const bare: Seg[][] = [
    ...(hedges > 0 ? [[{ text: '∴ ⟲ ', tone: 'dim' as const }, { text: String(hedges), tone: 'warn' as const }]] : []),
    [{ text: '∴ …', tone: 'dim' }],
  ]
  // A long count on the narrowest band is wider than the row: it drops whole, never cut mid-number.
  return bare.find(row => width(row) <= max) ?? [{ text: '∴', tone: 'dim' }]
}

/** Braille cells in the meta row's growth trail, two turns per cell. */
const TRAIL_CELLS = 10
/** Marks a compaction in the growth trail: the context dropped there. */
const CUT = '↓'
const LEFT = [0, 0x40, 0x44, 0x46, 0x47]
const RIGHT = [0, 0x80, 0xa0, 0xb0, 0xb8]

/** Two levels per braille cell, each 0-4 dots rising from the bottom; an odd last level gets an empty right column. */
function dots(levels: number[]): string {
  let out = ''
  for (let i = 0; i < levels.length; i += 2) out += String.fromCharCode(0x2800 + (LEFT[levels[i] ?? 0] ?? 0) + (RIGHT[levels[i + 1] ?? 0] ?? 0))
  return out
}

/** Two values per braille cell, each 0..100 drawn as 0-4 dots rising from the bottom. */
export function braille(values: number[]): string {
  return dots(values.map(v => Math.max(0, Math.min(4, Math.round((v / 100) * 4)))))
}

/**
 * Per-turn growth as braille: `past` holds earlier turns, `now` the newest cell. Scales to the
 * largest value shown; every real turn gets at least one dot (negatives count as 0), padding none.
 * A compaction draws `↓` in amber before the cell holding the first turn after it.
 * @param history - earlier turns' growth, in points of the window, oldest first; null marks a compaction
 * @param current - this turn's growth in points, or null when unmeasured
 * @param cells - braille cells to draw, two turns each
 */
export function growthTrail(history: Trail, current: number | null, cells: number): { past: Seg[]; now: string } {
  const turns: number[] = []
  const cuts = new Set<number>() // a compaction before turns[i]
  for (const v of [...history, current ?? 0]) {
    if (v === null) cuts.add(turns.length)
    else turns.push(Math.max(0, v))
  }
  const shown = turns.slice(-cells * 2)
  const first = turns.length - shown.length
  const pad = cells * 2 - shown.length
  const max = Math.max(...shown) || 1
  const levels = [...Array<number>(pad).fill(0), ...shown.map(v => Math.max(1, Math.round((v / max) * 4)))]
  const cutCells = new Set([...cuts].filter(i => i >= first).map(i => Math.floor((i - first + pad) / 2)))
  const past: Seg[] = []
  for (let k = 0; k < cells; k++) {
    if (cutCells.has(k)) past.push({ text: CUT, tone: 'warn' })
    if (k === cells - 1) break
    const cell = dots(levels.slice(k * 2, k * 2 + 2))
    const last = past.at(-1)
    if (last?.tone === 'dim') last.text += cell
    else past.push({ text: cell, tone: 'dim' })
  }
  return { past, now: dots(levels.slice(-2)) }
}

/** Growth in points of the window, always signed, one decimal under 10: `+0.6%`, `-12%`; never `-0.0%`. */
export function formatGrowth(points: number): string {
  const abs = Math.abs(points)
  const body = abs < 10 ? abs.toFixed(1) : String(Math.round(abs))
  return (points < 0 && body !== '0.0' ? '-' : '+') + body + '%'
}

/**
 * Meta row, fitted to `max` cells: drop the tool count, the trail, then the whole row.
 * @param growth - this turn's growth in points of the window, or null when unmeasured
 * @param history - earlier turns' growth in points, oldest first; null marks a compaction
 */
export function metaRow(meta: Meta, growth: number | null, history: Trail, max: number): Seg[] {
  const head = `◆ ${formatSecs(meta.thinkMs)} · ${meta.blocks} blk`
  const tools = ` · ${meta.tools} ${meta.tools === 1 ? 'tool' : 'tools'}`
  if (growth === null) {
    const plain = [head + tools, head].map(text => [{ text, tone: 'dim' as Tone }])
    return plain.find(c => width(c) <= max) ?? []
  }
  const drawn = formatGrowth(growth)
  // Amber follows the figure as drawn: 9.96 rounds to `+10.0%`, so the unrounded number would miss it.
  const tone: Tone = Number.parseFloat(drawn) >= 10 ? 'warn' : 'bright'
  const g: Seg[] = [{ text: '   ', tone: 'dim' }, { text: drawn, tone }]
  const trail = growthTrail(history, growth, TRAIL_CELLS)
  const t: Seg[] = [{ text: ' ', tone: 'dim' }, ...trail.past, { text: trail.now, tone }]
  const candidates: Seg[][] = [
    [{ text: head + tools, tone: 'dim' }, ...g, ...t],
    [{ text: head, tone: 'dim' }, ...g, ...t],
    [{ text: head, tone: 'dim' }, ...g],
  ]
  return candidates.find(c => width(c) <= max) ?? []
}

// The band: the three rows together.

/** The widest the band draws, in terminal cells. */
const MAX_WIDTH = 84
/** The share of the body's columns the band may take. */
const WIDTH_SHARE = 0.6
/** Under this many cells the band draws nothing. */
const MIN_WIDTH = 12
/** The most names the focus row shows. */
export const FOCUS_TERMS = 3
/** Cells the engine's `[-]` collapse mark covers at the band's top-right corner, plus a gap. */
export const CORNER = 4

/** The band's width in a body `columns` wide, or null when too narrow to draw. */
export function bandWidth(columns: number): number | null {
  const cells = Math.min(MAX_WIDTH, Math.floor(columns * WIDTH_SHARE))
  return cells < MIN_WIDTH ? null : cells
}

/**
 * The band's rows for a turn, top to bottom: focus, timeline, meta. A band short of rows keeps
 * the bottom ones, the top row stops short of the corner, and a row with nothing to show drops.
 * @param trail - recent turns' growth; a done turn's own growth is already its last number, and a
 *   compaction after it belongs to the next turn
 * @param max - width in terminal cells
 * @param maxRows - most rows the band may take; under 1 draws nothing
 */
export function bandRows(t: TurnMeta, trail: Trail, ctx: Ctx | null, max: number, maxRows: number): Seg[][] {
  const growth = t.done ? t.final : growthOf(t, ctx)
  const history = t.done && t.final !== null ? trail.slice(0, Math.max(0, trail.findLastIndex(v => v !== null))) : trail
  const meta = { thinkMs: phaseTotals(t.spans, t.now).think, blocks: t.blocks, tools: t.tools }
  const all = [
    (cells: number) => focusRow(topTerms(t.focus, FOCUS_TERMS), t.hedges, cells),
    (cells: number) => timelineRow(t.spans, t.started, t.now, cells),
    (cells: number) => metaRow(meta, growth, history, cells),
  ]
  // `slice(-0)` keeps every row, so no rows is its own case.
  const builders = maxRows < 1 ? [] : all.slice(-maxRows)
  return builders
    .map((build, i): Seg[] => (i === 0 ? [...build(max - CORNER), { text: ' '.repeat(CORNER), tone: 'dim' }] : build(max)))
    .filter(row => row.some(seg => seg.text.trim() !== ''))
}
