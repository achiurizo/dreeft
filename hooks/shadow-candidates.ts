// Memory shadow mode (experimental): pick candidate facts from a turn's thinking, each with
// its outcome evidence. Pure.

import { FOCUS_MIN, HEDGE, scanThought } from './focus'
import type { ShadowTurn } from './shadow'

/** Where outcome evidence came from: a tool result or the final answer. */
export type Evidence = { from: 'tool'; tool: string; snippet: string } | { from: 'text'; snippet: string }

export type Candidate = {
  source: 'hedge' | 'focus'
  /** The repeated name, for a focus candidate. */
  term?: string
  span: string
  evidence: Evidence | null
}

export const SPAN_MAX = 500
const SNIPPET_MAX = 300
/** Hedge candidates kept per turn, then focus candidates, then the total. */
const HEDGE_MAX = 4
const FOCUS_MAX = 3
const CANDIDATE_MAX = 6
/** A corrected belief says something: fewer words after the marker is a stall, not a claim. */
const MIN_WORDS = 6

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Sentences of `text`, each with its start offset; a newline also ends one, a dot inside `foo.ts` does not. */
function sentences(text: string): { at: number; s: string }[] {
  const out: { at: number; s: string }[] = []
  const re = /(?:[^.!?\n]|[.!?](?=[^\s.!?]))+(?:[.!?]+(?=\s|$)|\n+|$)/g
  for (const m of text.matchAll(re)) {
    const s = m[0].trim()
    if (s !== '') out.push({ at: m.index + m[0].length - m[0].trimStart().length, s })
  }
  return out
}

/** After the marker, a plan or a question is not a corrected belief. */
const PLAN = /^[\s,.:;!-]*(let me|let's|i'll|i will|i need|i should|i want|i'm going|now|ok(ay)?\b|so\b)/i

/**
 * Hedge-then-correction spans: from a second-guess marker through the end of the next sentence,
 * kept when what follows the marker is a statement of at least `MIN_WORDS` words, not a plan or
 * a question.
 */
export function hedgeSpans(thinking: string): string[] {
  const out: string[] = []
  let end = -1
  for (const m of thinking.matchAll(HEDGE)) {
    if (m.index < end) continue // inside the previous span
    const rest = thinking.slice(m.index + m[0].length)
    const parts = sentences(rest).slice(0, 2)
    const first = parts[0]?.s ?? ''
    if (PLAN.test(first) || first.endsWith('?')) continue
    if (first.split(/\s+/).filter(Boolean).length < MIN_WORDS) continue
    const last = parts.at(-1)
    end = m.index + m[0].length + (last ? last.at + last.s.length : 0)
    out.push(clip(squash(thinking.slice(m.index, end)), SPAN_MAX))
  }
  return out
}

/** Names the turn came back to at least twice, from its thinking and its tool calls, most first. */
export function repeatedTerms(turn: ShadowTurn): { t: string; n: number }[] {
  const counts = new Map<string, number>()
  const add = (t: string) => counts.set(t, (counts.get(t) ?? 0) + 1)
  scanThought('', `${turn.thinking} `).terms.forEach(add)
  turn.tools.forEach(u => u.terms.forEach(add))
  return [...counts]
    .filter(([, n]) => n >= FOCUS_MIN)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => ({ t, n }))
}

/** The text around `needle` in `hay`, or its head when the needle is absent. */
function around(hay: string, needle: string | null): string {
  const i = needle ? hay.indexOf(needle) : -1
  const from = Math.max(0, i < 0 ? 0 : i - SNIPPET_MAX / 2)
  return clip(squash(hay.slice(from, from + SNIPPET_MAX)), SNIPPET_MAX)
}

/**
 * Outcome evidence for a claim naming `terms`: the last successful tool call that touched one of
 * them or printed one, else the answer's sentence that names one.
 */
export function findEvidence(turn: ShadowTurn, terms: string[]): Evidence | null {
  if (terms.length === 0) return null
  for (const u of [...turn.tools].reverse()) {
    if (u.isError) continue
    const hit = terms.find(t => u.terms.includes(t) || u.text.includes(t))
    if (hit !== undefined && u.text.trim() !== '') return { from: 'tool', tool: u.name, snippet: around(u.text, u.text.includes(hit) ? hit : null) }
  }
  const said = sentences(turn.text).find(p => terms.some(t => p.s.includes(t)))
  return said ? { from: 'text', snippet: clip(squash(said.s), SNIPPET_MAX) } : null
}

/** Thinking sentences that name `term`, the last two joined, clipped to `SPAN_MAX`. */
function mentions(thinking: string, term: string): string {
  const hits = sentences(thinking).filter(p => p.s.includes(term)).slice(-2)
  return clip(squash(hits.map(p => p.s).join(' … ')), SPAN_MAX)
}

/** The turn's candidates: hedge spans first, then repeated names the thinking discussed. */
export function selectCandidates(turn: ShadowTurn): Candidate[] {
  const hedges: Candidate[] = hedgeSpans(turn.thinking)
    .slice(0, HEDGE_MAX)
    .map(span => ({ source: 'hedge', span, evidence: findEvidence(turn, scanThought('', `${span} `).terms) }))
  const focus: Candidate[] = []
  for (const { t } of repeatedTerms(turn)) {
    if (focus.length >= FOCUS_MAX) break
    const span = mentions(turn.thinking, t)
    if (span === '') continue // only tool calls named it: no belief to judge
    focus.push({ source: 'focus', term: t, span, evidence: findEvidence(turn, [t]) })
  }
  return [...hedges, ...focus].slice(0, CANDIDATE_MAX)
}
