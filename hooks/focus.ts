// Focus: the names the thinking mentions, found without a model call.

import type { Term } from '../types'

const CARRY_MAX = 200
const FOCUS_MAX = 50
/** A second-guess marker in thinking text. */
export const HEDGE = /\b(wait|actually|hmm+)\b/gi
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

/** Arguments that name the file a tool reads or writes. */
const FILE_ARGS = ['file_path', 'notebook_path']
/** Arguments that hold a search, scanned for code names the way thinking text is. */
const SEARCH_ARGS = ['pattern', 'query']

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
    const term = path === null ? null : normTerm(path)
    if (term !== null) terms.push(term)
  }
  for (const key of SEARCH_ARGS) {
    const search = text(key)
    if (search !== null) terms.push(...scanThought('', `${search} `).terms)
  }
  for (const m of (text('command') ?? '').matchAll(TOKEN)) {
    const term = FILE.test(m[0]) ? normTerm(m[0]) : null
    if (term !== null) terms.push(term)
  }
  return terms
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
