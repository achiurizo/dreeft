// Memory shadow mode (experimental): pick candidate facts from a turn's thinking, judge them,
// and shape log records. Pure: no `$`, so every step is testable without the engine.

import type { ToolCallInput, ToolCallResult, TurnCompleteInput, TurnStepChunk, TurnStepInput } from 'claude-code'

import { FOCUS_MIN, HEDGE, scanThought, toolTerms } from './lib'

/** What one main-loop turn left behind for the shadow pass. */
export type ShadowTurn = {
  turnId: string
  /** The turn's thinking text, blocks separated by a blank line. */
  thinking: string
  /** The turn's final answer text. */
  text: string
  /** The turn's tool calls with what they returned, in order. */
  tools: ToolEvidence[]
}

/** One tool call: the names its arguments touch and the result text the model read. */
export type ToolEvidence = { name: string; terms: string[]; text: string; isError: boolean }

/** Where outcome evidence came from: a tool result or the final answer. */
export type Evidence = { from: 'tool'; tool: string; snippet: string } | { from: 'text'; snippet: string }

export type Candidate = {
  source: 'hedge' | 'focus'
  /** The repeated name, for a focus candidate. */
  term?: string
  span: string
  evidence: Evidence | null
}

/** The judge's answer for one candidate. */
export type Verdict = {
  verdict: 'keep' | 'drop' | 'error'
  fact: string | null
  /** Memory type, as the flush staging queue takes it. */
  type: 'user' | 'feedback' | 'project' | 'reference' | null
  /** Kebab-case memory name, as the flush staging queue takes it. */
  name: string | null
  /** ICM topic: decisions-<project>, context-<project>, errors-resolved, strategies-<domain>. */
  topic: string | null
  keywords: string[]
  importance: 'high' | 'medium' | null
  reason: string
}

/** What the judge call cost; the same on every record of one turn. */
export type JudgeMeta = { model: string; candidates: number; input_tokens: number | null; output_tokens: number | null }

/** One JSONL line in the shadow log: one candidate and its verdict. */
export type ShadowRecord = {
  schema: 1
  ts: string
  session: string
  turn: string
  project: string
  /** The repo's main checkout (worktrees resolved), which keys the flush staging queue. */
  root: string
  source: Candidate['source']
  term: string | null
  span: string
  evidence: Evidence | null
  confirmed: boolean
  judge: JudgeMeta
} & Verdict

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

/** The icm-tend keep/drop rubric, as the judge's system prompt. */
export const JUDGE_SYSTEM = `You review candidate facts taken from a coding session's private reasoning. Most are
noise: task status, a plan in flight, a guess. A few state a durable fact.

Keep a candidate only when the fact stays true after the session that wrote it:
a decision and its reason, a constraint, a gotcha, an architecture invariant.
Never keep task status, progress notes, plans in flight, questions, hypotheses,
or a restated prompt. An unconfirmed candidate (no outcome evidence) needs a
stronger claim to keep. When unsure, drop.

Return one JSON object and nothing else:
{"verdicts": [{"i": 0, "verdict": "keep" | "drop", "fact": "...", "type": "...",
  "name": "...", "topic": "...", "keywords": ["..."], "importance": "high" | "medium",
  "reason": "..."}]}

Rules:
- One verdict per candidate, by its index i. reason is one short line, always.
- On drop, fact, type, name, topic and keywords are null or empty.
- fact is one or two self-contained sentences. Name the project and the component.
  No "this", "it", or "the task" without a referent.
- type: "project" for a decision, constraint or invariant; "feedback" for a
  correction of an approach; "reference" for a tool, URL or external system;
  "user" only for a fact about the user.
- name: a kebab-case name of 2 to 5 words.
- topic: decisions-<project> for a decision, context-<project> for a constraint
  or invariant, errors-resolved for a fixed error, strategies-<domain> for a
  reusable approach. Lowercase letters, digits, hyphens.
- keywords: 2 to 6 single terms.
- importance: "high" for a decision or a gotcha that cost time, else "medium".`

/** The judge's one user message: the project and each candidate with its evidence. */
export function judgePrompt(project: string, candidates: Candidate[]): string {
  const items = candidates.map((c, i) => ({
    i,
    source: c.source,
    ...(c.term ? { term: c.term } : {}),
    span: c.span,
    evidence: c.evidence?.snippet ?? null,
    confirmed: c.evidence !== null,
  }))
  return `Project: ${project}\n\nCandidates:\n${JSON.stringify(items, null, 1)}`
}

const TYPES = ['user', 'feedback', 'project', 'reference'] as const
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const slug = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')

/** A verdict for a candidate the judge did not answer usably. */
export const failed = (reason: string): Verdict => ({ verdict: 'error', fact: null, type: null, name: null, topic: null, keywords: [], importance: null, reason })

/**
 * The judge's reply as one verdict per candidate. Untrusted: a missing, malformed or
 * incomplete entry becomes an `error` verdict, and a keep without a fact becomes one too.
 */
export function parseVerdicts(reply: string, count: number): Verdict[] {
  let raw: unknown
  try {
    const body = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
    raw = JSON.parse(body)
  } catch {
    return Array.from({ length: count }, () => failed('judge reply was not JSON'))
  }
  const list: unknown[] = isRecord(raw) && Array.isArray(raw.verdicts) ? raw.verdicts : []
  const byIndex = new Map<number, Record<string, unknown>>()
  for (const v of list) if (isRecord(v) && typeof v.i === 'number') byIndex.set(v.i, v)
  return Array.from({ length: count }, (_, i) => {
    const v = byIndex.get(i)
    if (!v) return failed('judge gave no verdict')
    const reason = str(v.reason) ?? ''
    if (v.verdict === 'drop') return { ...failed(reason), verdict: 'drop' }
    if (v.verdict !== 'keep') return failed(`judge verdict ${JSON.stringify(v.verdict)}`)
    const fact = str(v.fact)
    if (!fact) return failed('keep without a fact')
    const name = str(v.name)
    const topic = str(v.topic)
    return {
      verdict: 'keep',
      fact,
      type: TYPES.find(t => t === v.type) ?? 'project',
      name: slug(name ?? fact.split(/\s+/).slice(0, 5).join(' ')) || null,
      topic: topic ? slug(topic) : null,
      keywords: Array.isArray(v.keywords) ? v.keywords.filter((k): k is string => typeof k === 'string').slice(0, 6) : [],
      importance: v.importance === 'high' ? 'high' : 'medium',
      reason,
    }
  })
}

/** Where a record was made: the session, the turn and the project. */
export type RecordContext = { ts: string; session: string; turn: string; project: string; root: string }

/** One log record per candidate, its verdict and the judge call's cost attached. */
export function buildRecords(ctx: RecordContext, candidates: Candidate[], verdicts: Verdict[], judge: JudgeMeta): ShadowRecord[] {
  return candidates.map((c, i) => ({
    schema: 1,
    ...ctx,
    source: c.source,
    term: c.term ?? null,
    span: c.span,
    evidence: c.evidence,
    confirmed: c.evidence !== null,
    judge,
    ...(verdicts[i] ?? failed('judge gave no verdict')),
  }))
}

/**
 * What `memory-candidates.ts add` would take for a kept record, plus the fields `add` stamps
 * itself (`created_at`, `session`). Shown only to prove the record carries everything; the
 * shadow pass never stages.
 */
export function toStaging(r: ShadowRecord): { created_at: string; session: string; type: string; name: string; description: string; body: string } | null {
  if (r.verdict !== 'keep' || !r.fact || !r.type || !r.name) return null
  const lines = [
    r.fact,
    '',
    `**Why:** ${r.reason}`,
    `**Evidence:** ${r.evidence ? r.evidence.snippet : 'unconfirmed'}`,
    `**Source:** ${r.source} span, turn ${r.turn}: ${r.span}`,
    `**ICM:** topic ${r.topic ?? 'none'}, importance ${r.importance ?? 'medium'}, keywords ${r.keywords.join(', ') || 'none'}`,
  ]
  return { created_at: r.ts, session: r.session, type: r.type, name: r.name, description: r.fact, body: lines.join('\n') }
}

// The running turn's buffer.

/** Caps on what one turn buffers, so a runaway turn cannot grow the module without bound. */
const THINKING_MAX = 200_000
const RESULT_MAX = 2_000
const TOOLS_MAX = 200

/**
 * The shadow pass: the mod's own `turn.step`, `tool.call` and `turn.complete` hooks feed it, since
 * a plugin holds one unmatched hook per event.
 */
export type Shadow = {
  /** A main-loop step starts; step 0 opens a fresh turn buffer. */
  step: (e: TurnStepInput) => void
  /** A main-loop chunk streamed past. */
  chunk: (turnId: string, chunk: TurnStepChunk) => void
  /** A main-loop tool call resolved. */
  tool: (e: ToolCallInput, result: ToolCallResult) => void
  /** A main-loop turn completed: the turn to judge, or null when it was aborted or never seen. */
  complete: (e: TurnCompleteInput) => ShadowTurn | null
}

/** A fresh shadow pass, holding the running turn's buffer. */
export function createShadow(): Shadow {
  let turn: ShadowTurn | null = null
  let lastKind: TurnStepChunk['kind'] | null = null
  return {
    step: e => {
      if (e.index === 0) turn = { turnId: e.turnId, thinking: '', text: '', tools: [] }
      lastKind = null
    },
    chunk: (turnId, chunk) => {
      if (turn && turn.turnId === turnId) {
        if (chunk.kind === 'thinking' && turn.thinking.length < THINKING_MAX) {
          const gap = lastKind !== 'thinking' && turn.thinking !== '' ? '\n\n' : ''
          turn.thinking += gap + chunk.text
        } else if (chunk.kind === 'text') {
          turn.text += chunk.text
        }
      }
      lastKind = chunk.kind
    },
    tool: (e, result) => {
      if (!turn || turn.tools.length >= TOOLS_MAX || result.deny !== undefined) return
      turn.tools.push({ name: e.tool, terms: toolTerms(e), text: (result.text ?? '').slice(0, RESULT_MAX), isError: result.isError === true })
    },
    complete: e => {
      const done = turn && turn.turnId === e.turnId ? turn : null
      turn = null
      if (!done || e.isAborted || e.reason === 'aborted') return null
      return { ...done, text: done.text || e.answer }
    },
  }
}
