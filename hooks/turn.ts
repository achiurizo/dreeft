// The turn: where its time goes, and how each chunk folds into it.

import type { TurnStepChunk } from 'claude-code'

import type { Ctx, Phase, Span, TurnMeta } from '../types'
import { addTerms, scanThought } from './focus'

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

/** The spinner's own word for what the turn is doing, as a phase; a tool call streaming in (`tool-input`) is the model writing. */
export function phaseOfMode(mode: 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use'): Phase {
  return mode === 'thinking' ? 'think' : mode === 'tool-use' ? 'tool' : mode === 'requesting' ? 'wait' : 'write'
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
    tail: '',
    lastChunk: null,
  }
}

/** Most spans a turn keeps, so a turn of thousands of steps does not grow the state written on every chunk. */
export const SPANS_MAX = 240

/** Over the cap, the shortest finished span folds into the one before it; the turn's start and running span stay. */
function capSpans(spans: Span[]): Span[] {
  if (spans.length <= SPANS_MAX) return spans
  const lengths = spans.slice(1, -1).map((s, i) => (spans[i + 2]?.at ?? s.at) - s.at)
  const drop = 1 + lengths.indexOf(Math.min(...lengths))
  // With the span gone, the same phase can sit on both sides: that is one span.
  const joined = spans[drop - 1]?.phase === spans[drop + 1]?.phase
  return spans.filter((_, i) => i !== drop && !(joined && i === drop + 1))
}

/** Enter `phase` at `now`; staying in the same phase adds no span. */
export function enterPhase(t: TurnMeta, phase: Phase, now: number): TurnMeta {
  const last = t.spans.at(-1)
  return { ...t, now, spans: last?.phase === phase ? t.spans : capSpans([...t.spans, { phase, at: now }]) }
}

/** A block's last word has no space after it: scan it once the block ends. */
function flush(t: TurnMeta): TurnMeta {
  // The next block opens a new sentence: its first word has no left context to inherit.
  if (t.carry === '') return t.tail === '' ? t : { ...t, tail: '' }
  const scan = scanThought(t.carry, ' ', t.tail)
  return { ...t, focus: addTerms(t.focus, scan.terms), hedges: t.hedges + scan.hedges, carry: '', tail: '' }
}

/** The chunk kinds `reduceChunk` folds; any other kind leaves the turn as it was. */
export const FOLDED: ReadonlySet<TurnStepChunk['kind']> = new Set(['thinking', 'text', 'tool', 'stop'])

/** Fold one main-loop chunk into the turn; no chunk enters `tool`, which starts when the step's stream ends. */
export function reduceChunk(t: TurnMeta, chunk: TurnStepChunk, now: number): TurnMeta {
  switch (chunk.kind) {
    case 'thinking': {
      // Text may be empty (thinking summaries off): it is still thinking time, with nothing to scan.
      // A block starts at the first thinking chunk after anything else; the spinner may have opened the span already.
      const fresh = t.lastChunk !== 'thinking'
      const scan = scanThought(t.carry, chunk.text, t.tail)
      return {
        ...enterPhase(t, 'think', now),
        blocks: t.blocks + (fresh ? 1 : 0),
        focus: addTerms(t.focus, scan.terms),
        hedges: t.hedges + scan.hedges,
        carry: scan.carry,
        tail: scan.tail,
        lastChunk: 'thinking',
      }
    }
    case 'text':
      return { ...enterPhase(flush(t), 'write', now), lastChunk: 'text' }
    case 'tool':
      // The chunk marks the call's start: its arguments are still to stream, so the model is writing.
      return { ...enterPhase(flush(t), 'write', now), tools: t.tools + 1, lastChunk: 'tool' }
    case 'stop':
      return { ...t, now, lastChunk: 'stop' }
    default:
      return t
  }
}

/** A token count as reported, or 0 when the field is missing or not a finite number. */
const count = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/** A response's input side: fresh tokens plus what the cache read and wrote; a missing or non-finite field counts as 0. */
export function inputTokens(u: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number {
  return count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens)
}

/** Context growth since the turn's step 0, in percentage points of the window; null when unmeasured or not a finite number. */
export function growthOf(t: TurnMeta | null, c: Ctx | null): number | null {
  if (!t || !c || t.startTokens === null || t.window <= 0) return null
  const points = Math.round(((c.tokens - t.startTokens) / t.window) * 10000) / 100
  // A NaN or an infinity here would reach the trail, which scales every cell to its largest number.
  return Number.isFinite(points) ? points : null
}
