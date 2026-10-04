// Memory shadow mode (experimental): judge a turn's candidate facts and append them to a log.
// Never writes memory, never stages, never changes the turn. The side of `shadow.ts` that reaches
// outside: every engine call goes through a `ShadowIo`, so this file holds no `$` either.

import type { EngineInterface } from 'claude-code'

import { inputTokens } from './turn'
import { JUDGE_SYSTEM, buildRecords, failed, judgePrompt, parseVerdicts, selectCandidates } from './shadow'
import type { JudgeMeta, ShadowTurn } from './shadow'

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

/** The cheapest model the judge may use. */
const JUDGE_MODEL = 'claude-haiku-4-5-20251001'
/** The log, under `$HOME`. */
const LOG_DIR = '.local/state/dreeft'
const LOG_FILE = 'memory-shadow.jsonl'

/** The project's name and its main checkout. */
type Where = { project: string; root: string }
/** Found once per load. */
let where: Promise<Where> | undefined

async function locate(io: ShadowIo): Promise<Where> {
  const cwd = await io.cwd()
  const git = async (...args: string[]) => {
    const r = await io.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 }).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout.trim() : ''
  }
  const common = await git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const root = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : (await git('rev-parse', '--show-toplevel')) || cwd
  const remote = await git('remote', 'get-url', 'origin')
  // A remote may carry credentials; keep host and path only.
  const project = remote.replace(/^[a-z+]+:\/\/[^@/]*@/i, 'https://') || root.split('/').filter(Boolean).at(-1) || cwd
  return { project, root }
}

/** Appends lines to the log with `>>`, so concurrent sessions never drop each other's records. */
async function append(io: ShadowIo, lines: string): Promise<void> {
  const home = await io.home()
  if (!home) return
  const dir = `${home}/${LOG_DIR}`
  await io.run(['/bin/sh', '-c', 'mkdir -p "$1" && cat >> "$1/$2"', 'sh', dir, LOG_FILE], { stdin: lines, timeoutMs: 5000 })
}

/** Judge one finished turn and log every candidate; nothing at all when it has none. */
export async function judgeTurn(io: ShadowIo, done: ShadowTurn): Promise<void> {
  const candidates = selectCandidates(done)
  if (candidates.length === 0) return
  where ??= locate(io)
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
  await append(io, records.map(r => `${JSON.stringify(r)}\n`).join(''))
}
