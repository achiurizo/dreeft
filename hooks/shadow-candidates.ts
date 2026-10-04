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
const FOCUS_CANDIDATES = 3
const CANDIDATE_MAX = 6
/** A corrected belief says something: fewer words after the marker is a stall, not a claim. */
const MIN_WORDS = 6

/** How far past a marker a hedge span is read: its two sentences are clipped to `SPAN_MAX` anyway. */
const HEDGE_WINDOW = SPAN_MAX * 4

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Secret shapes a tool result or a thought can carry; the log and the judge never see them. */
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]'],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/]*)?@/gi, '$1[redacted]@'],
  [/(?<![\w.-])([\w.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w.-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]'],
  [/\b((?:bearer|basic)\s+)[\w.~+/=-]{8,}/gi, '$1[redacted]'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)[-_][\w-]{8,}|\bsk-[\w-]{20,}|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[redacted]'],
]

/** `text` with anything shaped like a credential replaced by `[redacted]`. */
export const redact = (text: string) => SECRETS.reduce((s, [re, to]) => s.replace(re, to), text)

/** How much of one sentence is redacted: the clip to `SPAN_MAX` or `SNIPPET_MAX` follows anyway. */
const REDACT_WINDOW = SPAN_MAX * 4

/** Where a sentence ends: closing punctuation before a space or the end, or a newline. */
const SENTENCE_END = /(?<![.!?])[.!?]+(?=\s|$)|\n+/g

/** Sentences of `text`, each with its start offset; a newline also ends one, a dot inside `foo.ts` or `../a` does not. */
function sentences(text: string): { at: number; s: string }[] {
  const out: { at: number; s: string }[] = []
  let from = 0
  const cut = (to: number) => {
    const raw = text.slice(from, to)
    // Punctuation alone says nothing.
    if (/[^\s.!?]/.test(raw)) out.push({ at: from + raw.length - raw.trimStart().length, s: raw.trim() })
    from = to
  }
  for (const m of text.matchAll(SENTENCE_END)) cut(m.index + m[0].length)
  cut(text.length)
  return out
}

/** After the marker, a plan or a question is not a corrected belief. */
const PLAN = /^[\s,.:;!-]*(let me|let's|i'll|i will|i need|i should|i want|i'm going|now|ok(ay)?\b|so\b)/i

/**
 * Hedge-then-correction spans, the first `HEDGE_MAX`: from a second-guess marker through the end
 * of the next sentence, kept when what follows the marker is a statement of at least `MIN_WORDS`
 * words, not a plan or a question.
 */
export function hedgeSpans(thinking: string): string[] {
  const out: string[] = []
  let end = -1
  for (const m of thinking.matchAll(HEDGE)) {
    if (out.length >= HEDGE_MAX) break
    if (m.index < end) continue // inside the previous span
    const from = m.index + m[0].length
    const rest = thinking.slice(from, from + HEDGE_WINDOW)
    const parts = sentences(rest).slice(0, 2)
    const first = parts[0]?.s ?? ''
    if (PLAN.test(first) || first.endsWith('?')) continue
    if (first.split(/\s+/).filter(Boolean).length < MIN_WORDS) continue
    const last = parts.at(-1)
    end = from + (last ? last.at + last.s.length : 0)
    out.push(clip(squash(redact(thinking.slice(m.index, end))), SPAN_MAX))
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
    if (hit === undefined || u.text.trim() === '') continue
    // Redacted before the cut, so a secret the cut would split is still recognised whole.
    const text = redact(u.text)
    return { from: 'tool', tool: u.name, snippet: around(text, text.includes(hit) ? hit : null) }
  }
  const said = sentences(turn.text).find(p => terms.some(t => p.s.includes(t)))
  return said ? { from: 'text', snippet: clip(squash(redact(said.s.slice(0, REDACT_WINDOW))), SNIPPET_MAX) } : null
}

/** The sentences that name `term`, the last two joined, clipped to `SPAN_MAX`. */
function mentions(thought: { s: string }[], term: string): string {
  const hits = thought.filter(p => p.s.includes(term)).slice(-2)
  return clip(squash(redact(hits.map(p => p.s.slice(0, REDACT_WINDOW)).join(' … '))), SPAN_MAX)
}

/**
 * The turn's candidates: hedge spans first, then repeated names the thinking discussed. A name
 * whose mentions a hedge span already holds is not judged twice.
 */
export function selectCandidates(turn: ShadowTurn): Candidate[] {
  const hedges: Candidate[] = hedgeSpans(turn.thinking)
    .map(span => ({ source: 'hedge', span, evidence: findEvidence(turn, scanThought('', `${span} `).terms) }))
  const focus: Candidate[] = []
  const thought = sentences(turn.thinking)
  for (const { t } of repeatedTerms(turn)) {
    if (focus.length >= FOCUS_CANDIDATES) break
    if (redact(t) !== t) continue // the name itself is a credential: never logged, never judged
    const span = mentions(thought, t)
    if (span === '') continue // only tool calls named it: no belief to judge
    if (hedges.some(h => h.span.includes(span))) continue
    focus.push({ source: 'focus', term: t, span, evidence: findEvidence(turn, [t]) })
  }
  return [...hedges, ...focus].slice(0, CANDIDATE_MAX)
}
