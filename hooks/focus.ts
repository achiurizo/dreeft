// Focus: the names the thinking mentions, found without a model call.

import type { Term } from '../types'

const CARRY_MAX = 200
const FOCUS_MAX = 50
/** Scanned text kept as left context: longer than any marker, so a match reaching past it never began at its cut edge. */
const TAIL_MAX = 48
/**
 * A sentence that opens with an interjection: "Actually, the types already cover it." The bare
 * words are verb and adverb far more often ("wait for CI", "actually works"), so the marker needs
 * a sentence start before it and punctuation after it.
 */
const INTERJECTION = String.raw`(?<=^|[.!?:]\s+)(?:wait|actually|hmm+|oh|oops|no)(?=\s*[,.!\u2014-]\s)`
/** A narrated change of mind: summarized thinking says "I realize" more often than it says "wait". */
const REALIZATION = String.raw`\b(?:I(?:['\u2019]m| am) realizing|I (?:just )?realized?|turns out|on closer (?:look|inspection|reading)|(?:I need to|let me|I should) reconsider)\b`
/**
 * A second-guess marker in thinking text. Measured over 686 thinking blocks in 60 sessions: the
 * bare words matched 213 times with no reversal among 14 sampled; these two shapes match 35 times.
 */
export const HEDGE = new RegExp(`${INTERJECTION}|${REALIZATION}`, 'gim')
const TOKEN = /`([^`\n]+)`|[A-Za-z_][\w./-]*\w/g
/** A file name by its extension; `.tmpl` after one is a template of that file, and part of the name. */
const FILE = /\.(tsx?|jsx?|mjs|cjs|json|md|py|rb|go|rs|sh|fish|toml|ya?ml|css|html|txt)(\.tmpl)?$/i
/** A file name that has no extension, alone or as a path's last part; exact case, since `Make` and `makefile` are prose. */
const BARE = /(?:^|\/)(?:Justfile|Makefile|Dockerfile|Gemfile|Rakefile)$/
/** The Windows path separator, split on only in a tool's file argument: in prose and commands a backslash is an escape. */
const BACKSLASH = /\\/g

/** What a term may hold: printable ASCII, so each character is one cell and none is a control character. */
const DRAWABLE = /^[\x20-\x7e]+$/

/**
 * A backticked name, path or code identifier as a term: no `()`, a path's last part, 3-40 long.
 * Anything the band cannot draw at a known width is no term: the engine refuses a row holding a
 * control character, and a wide character would push the row past its measured width.
 */
function normTerm(raw: string): string | null {
  let s = raw.trim().replace(/\(\)$/, '')
  if (s.includes('/')) s = s.split('/').filter(Boolean).at(-1) ?? ''
  return s.length >= 3 && s.length <= 40 && DRAWABLE.test(s) ? s : null
}

/** Plain words are prose; a file name, a path of three parts or more, camelCase or snake_case is code. */
const isCode = (w: string) => w.split('/').length > 2 || FILE.test(w) || BARE.test(w) || /[a-z][A-Z]/.test(w) || /[A-Za-z]_[A-Za-z]/.test(w)

/** A run of backticks is a fence or an empty span, never the edge of a name. */
const blankRuns = (s: string) => s.replace(/`{2,}/g, run => ' '.repeat(run.length))
const isOdd = (s: string) => (s.match(/`/g) ?? []).length % 2 === 1

/**
 * Scan thinking text for terms and second-guesses. Text after the last space, or from a backtick
 * still open on the last line, is held back as `carry` so a name split across chunks still counts.
 * A name never spans lines, so a fence or a stray backtick holds nothing past its own line; held
 * text that outgrows `CARRY_MAX` was no name, and is scanned as prose.
 *
 * A second-guess is a phrase in a sentence position, so it needs the text before it: `tail` is the
 * end of what was already scanned. Only a marker that reaches past the tail counts, which is one
 * the earlier pieces could not have counted.
 */
export function scanThought(carry: string, piece: string, tail = ''): { terms: string[]; hedges: number; carry: string; tail: string } {
  const text = blankRuns(carry + piece)
  let cut = text.search(/\s\S*$/) + 1
  if (isOdd(text.slice(text.lastIndexOf('\n', cut - 1) + 1, cut))) cut = text.lastIndexOf('`', cut - 1)
  const held = text.slice(cut)
  const ready = held.length > CARRY_MAX ? text.replaceAll('`', ' ') : text.slice(0, cut)
  const rest = held.length > CARRY_MAX ? '' : held
  const terms: string[] = []
  for (const m of ready.matchAll(TOKEN)) {
    const term = m[1] !== undefined ? normTerm(m[1]) : isCode(m[0]) ? normTerm(m[0]) : null
    if (term !== null) terms.push(term)
  }
  const scanned = tail + ready
  let hedges = 0
  for (const m of scanned.matchAll(HEDGE)) if (m.index + m[0].length > tail.length) hedges++
  return { terms, hedges, carry: rest, tail: scanned.slice(-TAIL_MAX) }
}

/** Arguments that name the file a tool reads or writes. */
const FILE_ARGS = ['file_path', 'notebook_path']
/** Arguments that hold a search, scanned for code names the way thinking text is. */
const SEARCH_ARGS = ['pattern', 'query']

/**
 * The patterns that decide what a name is, as one string. The shadow log's code stamp is taken
 * over it, so a change to what counts as a name shows in the log.
 */
export const SCAN = [TOKEN.source, FILE.source, FILE.flags, BARE.source, BACKSLASH.source, DRAWABLE.source, ...FILE_ARGS, ...SEARCH_ARGS].join('\n')

/**
 * The names a tool call touches, from its arguments: the file it names, code names in its search,
 * and file names in its shell command. Directories and every other argument count nothing, so a
 * repo path repeated in each command cannot crowd out the files.
 */
export function toolTerms(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const args = new Map(Object.entries(input))
  const text = (key: string) => {
    const v = args.get(key)
    return typeof v === 'string' ? v : null
  }
  const terms: string[] = []
  for (const key of FILE_ARGS) {
    const path = text(key)
    const term = path === null ? null : normTerm(path.replace(BACKSLASH, '/'))
    if (term !== null) terms.push(term)
  }
  for (const key of SEARCH_ARGS) {
    const search = text(key)
    if (search !== null) terms.push(...scanThought('', `${search} `).terms)
  }
  for (const m of (text('command') ?? '').matchAll(TOKEN)) {
    const term = FILE.test(m[0]) || BARE.test(m[0]) ? normTerm(m[0]) : null
    if (term !== null) terms.push(term)
  }
  return terms
}

/**
 * A full list without its weakest term: the lowest count, the oldest on a tie. The last term is
 * the one just added and stays: at a count of 1 it would always be the weakest, and no new name
 * could enter a list of names all mentioned twice.
 */
function evict(focus: Term[]): Term[] {
  let drop = 0
  let low = Infinity
  focus.slice(0, -1).forEach((f, i) => {
    if (f.n < low) [drop, low] = [i, f.n]
  })
  return focus.filter((_, i) => i !== drop)
}

/**
 * Count each term; a seen term moves to the end, so recency breaks ties. Over `FOCUS_MAX` the
 * weakest term goes, so a much-mentioned name outlasts any number of names mentioned once.
 */
export function addTerms(focus: Term[], terms: string[]): Term[] {
  let out = focus
  for (const t of terms) {
    const seen = out.find(f => f.t === t)
    out = [...out.filter(f => f.t !== t), { t, n: (seen?.n ?? 0) + 1 }]
    if (out.length > FOCUS_MAX) out = evict(out)
  }
  return out
}

/** A name has to come back at least this often to count as focus. */
export const FOCUS_MIN = 2

/** The `k` most-mentioned terms with at least `FOCUS_MIN` mentions; ties go to the most recent. */
export function topTerms(focus: Term[], k: number): Term[] {
  return focus
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.n >= FOCUS_MIN)
    .sort((a, b) => b.f.n - a.f.n || b.i - a.i)
    .slice(0, k)
    .map(x => x.f)
}
