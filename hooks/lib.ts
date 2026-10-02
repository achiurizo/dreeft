import type { TurnStepChunk } from 'claude-code'

import type { Phase, Span, Term, TurnMeta } from '../types'

/** How a segment is drawn: `faint` and `dim` recede, `warn` is amber, `think` and `tool` follow the palette. */
export type Tone = 'faint' | 'dim' | 'bright' | 'warn' | 'think' | 'tool'
/** A run of text in one tone; a row is a list of these. */
export type Seg = { text: string; tone: Tone }
/** The turn figures the meta row shows; `thinkMs` in milliseconds. */
export type Meta = { thinkMs: number; blocks: number; tools: number; outTok: number }

const width = (segs: Seg[]) => segs.reduce((n, s) => n + Array.from(s.text).length, 0)

/** Milliseconds as whole seconds: `42s`, or `1m5s` from a minute up. */
export function formatSecs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

// Focus: the names the thinking mentions, found without a model call.

const CARRY_MAX = 200
const FOCUS_MAX = 50
const HEDGE = /\b(wait|actually|hmm+)\b/gi
const TOKEN = /`([^`\n]+)`|[A-Za-z_][\w./-]*\w/g
const FILE = /\.(tsx?|jsx?|mjs|cjs|json|md|py|rb|go|rs|sh|fish|toml|ya?ml|css|html)$/i

/** A backticked name, path or code identifier as a term: no `()`, a path's last part, 3-40 long. */
function normTerm(raw: string): string | null {
  let s = raw.trim().replace(/\(\)$/, '')
  if (s.includes('/')) s = s.split('/').filter(Boolean).at(-1) ?? ''
  const n = Array.from(s).length
  return n >= 3 && n <= 40 ? s : null
}

/** Plain words are prose; a file name, a path, camelCase or snake_case is code. */
const isCode = (w: string) => w.includes('/') || FILE.test(w) || /[a-z][A-Z]/.test(w) || /[A-Za-z]_[A-Za-z]/.test(w)

/**
 * Scan thinking text for terms and second-guesses. Text after the last space, or from an
 * unclosed backtick, is held back as `carry` so a name split across chunks still counts.
 */
export function scanThought(carry: string, piece: string): { terms: string[]; hedges: number; carry: string } {
  const text = carry + piece
  let cut = text.search(/\s\S*$/) + 1
  if ((text.slice(0, cut).match(/`/g) ?? []).length % 2 === 1) cut = text.lastIndexOf('`', cut - 1)
  const ready = text.slice(0, cut)
  const rest = text.slice(cut)
  const terms: string[] = []
  for (const m of ready.matchAll(TOKEN)) {
    const term = m[1] !== undefined ? normTerm(m[1]) : isCode(m[0]) ? normTerm(m[0]) : null
    if (term !== null) terms.push(term)
  }
  return { terms, hedges: (ready.match(HEDGE) ?? []).length, carry: rest.length > CARRY_MAX ? '' : rest }
}

/** Count each term; a seen term moves to the end, so recency breaks ties. */
export function addTerms(focus: Term[], terms: string[]): Term[] {
  let out = focus
  for (const t of terms) {
    const seen = out.find(f => f.t === t)
    out = [...out.filter(f => f.t !== t), { t, n: (seen?.n ?? 0) + 1 }]
  }
  return out.slice(-FOCUS_MAX)
}

/** A name has to come back at least this often to count as focus. */
const FOCUS_MIN = 2

/** The `k` most-mentioned terms with at least `FOCUS_MIN` mentions; ties go to the most recent. */
export function topTerms(focus: Term[], k: number): Term[] {
  return focus
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.n >= FOCUS_MIN)
    .sort((a, b) => b.f.n - a.f.n || b.i - a.i)
    .slice(0, k)
    .map(x => x.f)
}

// Phases: where the turn's time goes.

function phaseAt(spans: Span[], t: number): Phase {
  let phase = spans[0]?.phase ?? 'wait'
  for (const s of spans) if (s.at <= t) phase = s.phase
  return phase
}

/** Milliseconds spent in each phase, the last span running to clock time `end`. */
export function phaseTotals(spans: Span[], end: number): Record<Phase, number> {
  const totals: Record<Phase, number> = { wait: 0, think: 0, tool: 0, write: 0 }
  spans.forEach((s, i) => {
    totals[s.phase] += Math.max(0, (spans[i + 1]?.at ?? end) - s.at)
  })
  return totals
}

/** Which phase a cell shows when several touch it: a short burst of thinking still marks its cell. */
const RANK: Phase[] = ['think', 'tool', 'write', 'wait']

/** The phases that run for some time inside [from, to), the turn ending at `end`. */
function phasesIn(spans: Span[], from: number, to: number, end: number): Set<Phase> {
  const seen = new Set<Phase>()
  spans.forEach((s, i) => {
    const stop = Math.min(to, spans[i + 1]?.at ?? end, end)
    if (stop > Math.max(from, s.at)) seen.add(s.phase)
  })
  return seen
}

/**
 * One cell per second of the turn, or whole seconds per cell once it outgrows `maxCells`.
 * @param start - clock time of the turn's start, in milliseconds
 * @param end - clock time the strip runs to, in milliseconds
 * @param maxCells - most cells the strip may take
 */
export function timelineCells(spans: Span[], start: number, end: number, maxCells: number): Phase[] {
  const dur = Math.max(0, end - start)
  const cellMs = 1000 * Math.max(1, Math.ceil(Math.ceil(dur / 1000) / Math.max(1, maxCells)))
  // At least one cell, so the row is there from the turn's first moment.
  return Array.from({ length: Math.max(1, Math.ceil(dur / cellMs)) }, (_, k) => {
    const from = start + k * cellMs
    const seen = phasesIn(spans, from, from + cellMs, end)
    return RANK.find(p => seen.has(p)) ?? phaseAt(spans, from)
  })
}

/** The spinner's own word for what the turn is doing, as a phase. */
export function phaseOfMode(mode: 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use'): Phase {
  return mode === 'thinking' ? 'think' : mode === 'responding' ? 'write' : mode === 'requesting' ? 'wait' : 'tool'
}

/**
 * A fresh turn, waiting on the model from `started`.
 * @param started - clock time of step 0, in milliseconds
 * @param startTokens - context tokens at step 0, or null when nothing has been measured
 * @param window - the context window in tokens, or 0 when unknown
 */
export function newTurn(started: number, startTokens: number | null, window: number): TurnMeta {
  return {
    blocks: 0,
    tools: 0,
    outTok: 0,
    startTokens,
    window,
    done: false,
    final: null,
    started,
    now: started,
    spans: [{ phase: 'wait', at: started }],
    focus: [],
    hedges: 0,
    carry: '',
    lastChunk: null,
  }
}

/** Enter `phase` at `now`; staying in the same phase adds no span. */
export function enterPhase(t: TurnMeta, phase: Phase, now: number): TurnMeta {
  const last = t.spans.at(-1)
  return { ...t, now, spans: last?.phase === phase ? t.spans : [...t.spans, { phase, at: now }] }
}

/** A block's last word has no space after it: scan it once the block ends. */
function flush(t: TurnMeta): TurnMeta {
  if (t.carry === '') return t
  const scan = scanThought(t.carry, ' ')
  return { ...t, focus: addTerms(t.focus, scan.terms), hedges: t.hedges + scan.hedges, carry: '' }
}

/** Fold one main-loop chunk into the turn. */
export function reduceChunk(t: TurnMeta, chunk: TurnStepChunk, now: number): TurnMeta {
  switch (chunk.kind) {
    case 'thinking': {
      // Text may be empty (thinking summaries off): it is still thinking time, with nothing to scan.
      // A block starts at the first thinking chunk after anything else; the spinner may have opened the span already.
      const fresh = t.lastChunk !== 'thinking'
      const scan = scanThought(t.carry, chunk.text)
      return {
        ...enterPhase(t, 'think', now),
        blocks: t.blocks + (fresh ? 1 : 0),
        focus: addTerms(t.focus, scan.terms),
        hedges: t.hedges + scan.hedges,
        carry: scan.carry,
        lastChunk: 'thinking',
      }
    }
    case 'text':
      return { ...enterPhase(flush(t), 'write', now), lastChunk: 'text' }
    case 'tool':
      return { ...enterPhase(flush(t), 'tool', now), tools: t.tools + 1, lastChunk: 'tool' }
    case 'stop':
      return { ...t, now, outTok: t.outTok + (chunk.usage?.output_tokens ?? 0), lastChunk: 'stop' }
    default:
      return t
  }
}

// Rows.

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
 * `∴` then the top terms with counts, then second-guesses; terms drop from the end to fit.
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
  return hedges > 0 ? [{ text: '∴ ⟲ ', tone: 'dim' }, { text: String(hedges), tone: 'warn' }] : [{ text: '∴ …', tone: 'dim' }]
}

/** Braille cells in the meta row's growth trail, two turns per cell. */
const TRAIL_CELLS = 10
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
 * @param history - earlier turns' growth, in points of the window, oldest first
 * @param current - this turn's growth in points, or null when unmeasured
 * @param cells - braille cells to draw, two turns each
 */
export function growthTrail(history: number[], current: number | null, cells: number): { past: string; now: string } {
  const real = [...history, current ?? 0].map(v => Math.max(0, v)).slice(-cells * 2)
  const max = Math.max(...real) || 1
  const levels = real.map(v => Math.max(1, Math.round((v / max) * 4)))
  while (levels.length < cells * 2) levels.unshift(0)
  return { past: dots(levels.slice(0, -2)), now: dots(levels.slice(-2)) }
}

/** A token count as `950`, `1.8k` or `42k`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

/** Growth in points of the window, always signed, one decimal under 10: `+0.6%`, `-12%`; never `-0.0%`. */
export function formatGrowth(points: number): string {
  const abs = Math.abs(points)
  const body = abs < 10 ? abs.toFixed(1) : String(Math.round(abs))
  return (points < 0 && body !== '0.0' ? '-' : '+') + body + '%'
}

/**
 * Meta row, fitted to `max` cells: drop the tool count, the trail, the token count, then the whole row.
 * @param growth - this turn's growth in points of the window, or null when unmeasured
 * @param history - earlier turns' growth in points, oldest first
 */
export function metaRow(meta: Meta, growth: number | null, history: number[], max: number): Seg[] {
  const head = `◆ ${formatSecs(meta.thinkMs)} · ${meta.blocks} blk`
  const tools = ` · ${meta.tools} ${meta.tools === 1 ? 'tool' : 'tools'}`
  const out = ` · ${formatTokens(meta.outTok)} out`
  if (growth === null) {
    const plain = [head + tools + out, head + out, head].map(text => [{ text, tone: 'dim' as Tone }])
    return plain.find(c => width(c) <= max) ?? []
  }
  const tone: Tone = growth >= 10 ? 'warn' : 'bright'
  const g: Seg[] = [{ text: '   ', tone: 'dim' }, { text: formatGrowth(growth), tone }]
  const trail = growthTrail(history, growth, TRAIL_CELLS)
  const t: Seg[] = [{ text: ' ' + trail.past, tone: 'dim' }, { text: trail.now, tone }]
  const candidates: Seg[][] = [
    [{ text: head + tools + out, tone: 'dim' }, ...g, ...t],
    [{ text: head + out, tone: 'dim' }, ...g, ...t],
    [{ text: head + out, tone: 'dim' }, ...g],
    [{ text: head, tone: 'dim' }, ...g],
  ]
  return candidates.find(c => width(c) <= max) ?? []
}
