// Memory shadow mode (experimental): judge a turn's candidate facts and append them to a log.
// Never writes memory, never stages, never changes the turn. The side of the shadow pass that reaches
// outside: every engine call goes through a `ShadowIo`, so this file holds no `$` either.

import type { EngineInterface } from 'claude-code'

import { inputTokens } from './turn'
import type { ShadowTurn } from './shadow'
import { selectCandidates } from './shadow-candidates'
import { JUDGE_SYSTEM, buildRecords, failed, judgePrompt, parseVerdicts, projectOf } from './shadow-judge'
import type { JudgeMeta } from './shadow-judge'

/** The engine calls the shadow pass makes, handed over by `register.tsx`. */
export type ShadowIo = {
  cwd: EngineInterface['session']['cwd']
  session: EngineInterface['session']['id']
  now: EngineInterface['clock']['now']
  run: EngineInterface['process']['run']
  complete: EngineInterface['model']['complete']
  /** `$HOME`, when set. */
  home: () => ReturnType<EngineInterface['env']['get']>
}

/** The cheapest model the judge may use: an alias, so each provider resolves its own id. */
const JUDGE_MODEL = 'haiku'
/** The log, under `$HOME`. */
const LOG_DIR = '.local/state/dreeft'
const LOG_FILE = 'memory-shadow.jsonl'

/** The project's name and its main checkout. */
type Where = { project: string; root: string }
/** Found once per load. */
let where: Promise<Where> | undefined
/** Judged names and spans one session remembers. */
const SEEN_MAX = 500

async function locate(io: ShadowIo): Promise<Where> {
  const cwd = await io.cwd()
  const git = async (...args: string[]) => {
    const r = await io.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 }).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout.trim() : ''
  }
  const common = await git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const root = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : (await git('rev-parse', '--show-toplevel')) || cwd
  const remote = await git('remote', 'get-url', 'origin')
  // A remote may carry credentials or a planted instruction; `projectOf` keeps host and path only.
  return { project: projectOf(remote, root.split('/').filter(Boolean).at(-1) || cwd), root }
}

/** Owner-only: the log quotes the session's thinking and tool results. */
const APPEND = 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && cat >> "$1/$2"'

/** Appends lines to the log with `>>`, so concurrent sessions never drop each other's records. */
async function append(io: ShadowIo, dir: string, lines: string): Promise<void> {
  const r = await io.run(['/bin/sh', '-c', APPEND, 'sh', dir, LOG_FILE], { stdin: lines, timeoutMs: 5000 })
  if (r.exitCode !== 0) throw new Error(`log append exited ${r.exitCode}: ${r.stderr.trim()}`)
}

/**
 * Judge one finished turn and log every candidate; nothing at all when it has none. `seen` holds
 * what earlier turns already judged, a focus name or a hedge span: a turn that repeats one is
 * not billed for it again.
 */
export async function judgeTurn(io: ShadowIo, done: ShadowTurn, seen: Set<string>): Promise<void> {
  const candidates = selectCandidates(done).filter(c => !seen.has(c.term ?? c.span))
  if (candidates.length === 0) return
  // Before the judge call: with nowhere to log, the call would be paid for nothing.
  const home = await io.home()
  if (!home) throw new Error('HOME is not set, so there is no log to write')
  if (seen.size >= SEEN_MAX) seen.clear()
  candidates.forEach(c => seen.add(c.term ?? c.span))
  where ??= locate(io).catch(err => {
    where = undefined // a failed lookup is tried again next turn
    throw err
  })
  const [{ project, root }, session, now] = await Promise.all([where, io.session(), io.now()])
  const reply = await io.complete({
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(project, candidates),
    maxTokens: 200 * candidates.length + 100,
    timeoutMs: 30_000,
  })
  const judge: JudgeMeta = {
    model: JUDGE_MODEL,
    candidates: candidates.length,
    input_tokens: inputTokens(reply.usage),
    output_tokens: reply.usage.output_tokens,
  }
  const verdicts = reply.isAnswered
    ? parseVerdicts(reply.text, candidates.length)
    : candidates.map(() => failed(`judge call failed: ${reply.reason}`))
  const records = buildRecords({ ts: new Date(now).toISOString(), session, turn: done.turnId, project, root }, candidates, verdicts, judge)
  await append(io, `${home}/${LOG_DIR}`, records.map(r => `${JSON.stringify(r)}\n`).join(''))
}
