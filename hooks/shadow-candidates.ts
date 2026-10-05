// Memory shadow mode (experimental): pick candidate facts from a turn's thinking, each with
// its outcome evidence. Pure.

import { FOCUS_MIN, HEDGE, SCAN, scanThought } from './focus'
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

/** A quoted value: an escaped quote does not end it, and one that never closes runs to the end of the text. */
const QUOTED = String.raw`"(?:[^"\\]|\\[\s\S]?)*(?:"|$)|'(?:[^'\\]|\\[\s\S]?)*(?:'|$)`
/** A value: quoted, else everything up to the next space, so `ab,cd;ef` goes whole. */
const VALUE = String.raw`(?:${QUOTED}|\S+)`
/** What follows a secret name: at most `NAME_TAIL` more name characters (a fixed bound keeps the match linear), then `:` or `=`. */
const NAME_TAIL = 64
const ASSIGN = String.raw`[\w.-]{0,${NAME_TAIL}}["']?\s*[:=]\s*`
/** How far a credential flag may sit after its command word, and an AWS secret key after its key id: fixed, so the match is linear. */
const FLAG_GAP = 200
const AWS_GAP = 64

/** A flag's value, only on the line of a command known to take a credential there: a bare `-p x` is `mkdir -p dir`. */
const flag = (commands: string, flags: string, value = VALUE): [RegExp, string] =>
  [new RegExp(String.raw`(\b(?:${commands})\b[^\n|;&]{0,${FLAG_GAP}}?\s(?:${flags}))(?![-<>|&;])${value}`, 'g'), '$1[redacted]']

/** Commands whose `-p` or `--password` takes a password. `psql` is absent: its `-p` is a port. */
const SQL = 'mysql|mysqldump|mysqladmin|mariadb|mongo|mongosh|mongodump|mongorestore'
const LOGIN = String.raw`sshpass|(?:docker|podman)\s+login`

/** Secret shapes a tool result or a thought can carry; the log and the judge never see them. */
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]'],
  // A password may hold a `/`; digits then a `/` after the colon are a port, not a password.
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+(?::[^\s/]*)?|[^\s/@:]*:(?!\d{1,5}[/?#])[^\s@]{0,256})@/gi, '$1[redacted]@'],
  [/(https:\/\/hooks\.slack\.com\/services\/)T[A-Z0-9]{6,14}\/B[A-Z0-9]{6,14}\/[A-Za-z0-9]{20,}/g, '$1[redacted]'],
  // `pass` only after a separator: `bypass=true` and a test count `pass: 177` are not secrets.
  [new RegExp(String.raw`((?:secret|token|passw(?:or)?d|passphrase|(?<=[_.-])pass(?![a-z])|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|credential|x-auth|x-amz-signature)${ASSIGN})${VALUE}`, 'gi'), '$1[redacted]'],
  // Case matters here: `pwd:` and `DB_PWD=` are keys, the shell's own `PWD=/home/me` is not.
  [new RegExp(String.raw`((?:(?<![A-Za-z])(?:pwd|Pwd)|(?<=[_-])PWD)(?![A-Za-z])${ASSIGN})${VALUE}`, 'g'), '$1[redacted]'],
  // A cookie header is secret to the end of its line; `Cookie banner: shown` has no colon after the name.
  [new RegExp(String.raw`((?<![a-z])cookie["']?:[ \t]*)(?:${QUOTED}|[^\r\n"']+)`, 'gi'), '$1[redacted]'],
  [/(\bauthorization["']?\s*[:=]\s*["']?)(?:((?:token|apikey|negotiate|ntlm)\s+)[\w.~+/=-]{8,}|[\w.~+/=-]{20,})/gi, '$1$2[redacted]'],
  [/\b((?:bearer|basic)\s+)[\w.~+/=-]{8,}/gi, '$1[redacted]'],
  flag(`${SQL}|${LOGIN}|curl|wget|redis-cli`, String.raw`--pass(?:word|wd|phrase)?\s+`),
  flag(`${SQL}|${LOGIN}`, String.raw`-p\s*`),
  flag('redis-cli', String.raw`-a\s+`),
  // `curl -u name` alone prompts for the password: only `name:password` carries one.
  flag('curl', String.raw`-u\s*|--(?:proxy-)?user[ =]\s*`, String.raw`(?:${QUOTED}|[^\s:'"]+:\S+)`),
  [/(\bhtpasswd\s+-[A-Za-z0-9]*b[A-Za-z0-9]*\s+\S+\s+\S+\s+)\S+/g, '$1[redacted]'],
  // The 40 characters after a key id are its secret key; the id itself goes with the tokens below.
  [new RegExp(String.raw`(\b(?:AKIA|ASIA)[0-9A-Z]{16}\b[\s\S]{0,${AWS_GAP}}?)(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`, 'g'), '$1[redacted]'],
  // Each prefix needs its vendor's length after it: `hf_hub_download` and `npm_config_registry` are names.
  [/\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)[-_][\w-]{8,}|\bsk-[\w-]{20,}|\bgh[pousr]_\w{20,}|\bgithub_pat_\w{20,}|\bxox[abprs]-[\w-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|(?<![\w-])eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|\bAIza[\w-]{35,}|\bgl(?:pat|dt|rt|ptt|cbt)-[\w.-]{20,}|\bnpm_[A-Za-z0-9]{36,}|\bhf_[A-Za-z0-9]{34,}|\bSG\.[\w-]{22}\.[\w-]{43,}|\bwhsec_[A-Za-z0-9+/=]{32,}|\bya29\.[\w.-]{20,}|\bAGE-SECRET-KEY-1[0-9A-Z]{58,}/g, '[redacted]'],
]

/** `text` with anything shaped like a credential replaced by `[redacted]`. */
export const redact = (text: string) => SECRETS.reduce((s, [re, to]) => s.replace(re, to), text)

/**
 * How far past a cut `redactHead` reads, so a shape the cut would split is seen whole: over twice
 * the longest bounded shape (a command word, its `FLAG_GAP` and a flag value; a 256-character URL
 * password) and the length of an ordinary JWT, which is recognised only once its third part starts.
 */
export const REDACT_OVERLAP = 1024

/**
 * The first `max` characters of `text`, redacted. Only a slice of `max + REDACT_OVERLAP` is read,
 * so the cost does not grow with `text`; a shape that opens before the cut is redacted to its end.
 */
export function redactHead(text: string, max: number): string {
  const slice = text.slice(0, max + REDACT_OVERLAP)
  const head = redact(slice)
  if (slice.length === text.length) return head.slice(0, max)
  // The slice's own end may split a shape: drop the tail no shape touched, at most the overlap.
  let same = 0
  while (same < REDACT_OVERLAP && same < head.length && head.at(-1 - same) === slice.at(-1 - same)) same++
  return head.slice(0, head.length - same).slice(0, max)
}

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
 * Everything that decides which spans become candidates and what the log hides, as one string:
 * the marker, the plan filter, the name patterns, the redaction shapes and the limits. The log's
 * code stamp is taken over it, so a change here shows in the log.
 */
export const SELECTION = [
  HEDGE.source, HEDGE.flags, PLAN.source, PLAN.flags, SCAN,
  ...SECRETS.flatMap(([shape, to]) => [shape.source, shape.flags, to]),
  HEDGE_MAX, FOCUS_CANDIDATES, CANDIDATE_MAX, MIN_WORDS, FOCUS_MIN, SPAN_MAX, SNIPPET_MAX, REDACT_OVERLAP,
].join('\n')

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
    // Redacted before the snippet cut. `u.text` was already cut to 2,000 characters when buffered, after `redactHead`.
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
