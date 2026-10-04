import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { ShadowRecord } from './shadow-judge'
import { STEP, answerBelow, beneath, complete, drain } from './testkit'

const ON = { options: { memoryShadow: 'on' } }
// Input arrives in three parts; the record's `input_tokens` is their sum.
const USAGE = { input_tokens: 600, output_tokens: 80, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 }
const THINKING = 'Actually, the engine never hands tool results to turn.step chunks at all.'
const KEEP = '{"verdicts":[{"i":0,"verdict":"keep","fact":"dreeft: tool results reach tool.call only.","type":"project","name":"tool-results-in-tool-call","topic":"context-dreeft","keywords":["tool.call"],"importance":"high","reason":"gotcha"}]}'

/** The world beneath the mod: the model, the shell, the session; records what the mod asked of them. */
function world(on: On, over: { home?: string | null; remote?: string; appendExit?: number; reply?: ModelCompleteResult } = {}) {
  const asked: ModelCompleteRequest[] = []
  const appended: string[] = []
  const argvs: string[][] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-02T00:00:00Z') })
  mock.env(on, over.home === null ? {} : { HOME: over.home ?? '/home/u' })
  const logged: string[] = []
  answerBelow(on)
  on('ui.log', async (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: '/repo/.worktrees/x' }))
  on('model.complete', async (_$, e) => {
    asked.push(e)
    return { value: over.reply ?? { isAnswered: true, text: KEEP, usage: USAGE } }
  })
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'No space left on device', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('--git-common-dir')) return out('/repo/.git\n')
    if (e.argv.includes('get-url')) return out(`${over.remote ?? 'https://tok@github.com/a/b.git'}\n`)
    if (e.argv[0] !== '/bin/sh') return out('')
    if (over.appendExit) return out('', over.appendExit)
    appended.push(e.init?.stdin ?? '')
    return out('')
  })
  return { asked, appended, argvs, clock, logged }
}

async function turnWith($: Engine, on: On, thinking: string) {
  beneath(on, [{ kind: 'thinking', index: 0, text: thinking }, { kind: 'text', index: 1, text: 'Done.' }])
  await drain($.turn.step(STEP))
}

const recordsOf = (appended: string[]): ShadowRecord[] => appended.join('').trim().split('\n').map(l => JSON.parse(l))

test('a turn with a candidate: one judge call, one record per candidate appended to the log', ON, async ($, on) => {
  const w = world(on)
  await turnWith($, on, THINKING)
  await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.model).toBe('haiku')
  // Owner-only: the log quotes thinking and tool results.
  expect(w.argvs.find(a => a[0] === '/bin/sh')).toEqual(['/bin/sh', '-c', 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && cat >> "$1/$2"', 'sh', '/home/u/.local/state/dreeft', 'memory-shadow.jsonl'])
  // Shadow mode only: git lookups and the log append, never icm or the flush staging queue.
  expect(w.argvs.map(a => a[0] === '/bin/sh' ? 'sh' : a.slice(0, 1).join(''))).toEqual(['git', 'git', 'sh'])
  const records = recordsOf(w.appended)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    schema: 1, ts: '2026-10-02T00:00:00.000Z', session: expect.any(String), turn: 't1', project: 'https://github.com/a/b.git', root: '/repo',
    source: 'hedge', span: THINKING, confirmed: false, verdict: 'keep', topic: 'context-dreeft', importance: 'high',
    judge: { model: 'haiku', candidates: 1, input_tokens: 900, output_tokens: 80 },
  })
})

test('a turn without candidates makes no judge call and logs nothing', ON, async ($, on) => {
  const w = world(on)
  await turnWith($, on, 'Reading the file.')
  await complete($, {})
  await w.clock.settle()
  expect(w.asked).toHaveLength(0)
  expect(w.appended).toHaveLength(0)
})

test('an aborted turn is skipped', ON, async ($, on) => {
  const w = world(on)
  await turnWith($, on, THINKING)
  await complete($, { isAborted: true, reason: 'aborted' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(0)
})

test('a subagent turn completing is skipped and leaves the main turn to be judged', ON, async ($, on) => {
  const w = world(on)
  await turnWith($, on, THINKING)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'sub1' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(0)
  await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(1)
})

test('a later turn that repeats a judged span is not judged again', ON, async ($, on) => {
  const w = world(on)
  const step = [{ kind: 'thinking', index: 0, text: THINKING }, { kind: 'text', index: 1, text: 'Done.' }] as const
  beneath(on, [...step], [...step])
  for (let n = 0; n < 2; n++) {
    await drain($.turn.step(STEP))
    await complete($, { answer: 'Done.' })
    await w.clock.settle()
  }
  expect(w.asked).toHaveLength(1)
  expect(recordsOf(w.appended)).toHaveLength(1)
})

test('without HOME there is no log: no judge call is paid for, and the debug log says why', ON, async ($, on) => {
  const w = world(on, { home: null })
  await turnWith($, on, THINKING)
  await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(0)
  expect(w.logged).toEqual([expect.stringContaining('HOME is not set')])
})

test('a log append that fails is reported to the debug log, not dropped silently', ON, async ($, on) => {
  const w = world(on, { appendExit: 1 })
  await turnWith($, on, THINKING)
  const result = await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(result.text).toBe('Done.')
  expect(w.logged).toEqual([expect.stringContaining('log append exited 1: No space left on device')])
})

test('a judge call that fails logs every candidate as an error verdict', ON, async ($, on) => {
  const w = world(on, { reply: { isAnswered: false, reason: 'empty-reply', usage: USAGE } })
  await turnWith($, on, THINKING)
  await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(recordsOf(w.appended)).toMatchObject([{ verdict: 'error', fact: null, reason: 'judge call failed: empty-reply' }])
})

test('credentials in the remote never reach the log or the judge, a password holding an @ included', ON, async ($, on) => {
  const w = world(on, { remote: 'https://user:p@ss@github.com/a/b.git' })
  await turnWith($, on, THINKING)
  await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(recordsOf(w.appended)[0]?.project).toBe('https://github.com/a/b.git')
  expect(w.asked[0]?.prompt).not.toContain('ss@')
})

test('shadow mode off by default: no judge call, the turn passes untouched', async ($, on) => {
  const w = world(on)
  await turnWith($, on, THINKING)
  const result = await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(result.text).toBe('Done.')
  expect(w.asked).toHaveLength(0)
  expect(w.argvs).toHaveLength(0)
})

test('a main-loop tool result that names the claim confirms it', ON, async ($, on) => {
  const w = world(on)
  const out = 'hooks/register.tsx:12 const LOG_FILE'
  on('tool.call', async () => ({ result: { stdout: out, stderr: '', interrupted: false }, text: out }))
  beneath(on,
    [{ kind: 'thinking', index: 0, text: 'Actually, the log file name lives in register.tsx and nowhere else at all.' }, { kind: 'tool', index: 1, id: 'u1', name: 'Bash' }],
    [{ kind: 'text', index: 0, text: 'Done.' }],
  )
  await drain($.turn.step(STEP))
  await $.tool.call({ tool: 'Bash', command: 'grep -n LOG_FILE hooks/register.tsx' })
  await drain($.turn.step({ ...STEP, index: 1 }))
  await complete($, { answer: 'Done.' })
  await w.clock.settle()
  const [record] = recordsOf(w.appended)
  expect(record).toMatchObject({ source: 'hedge', confirmed: true, evidence: { from: 'tool', tool: 'Bash', snippet: out } })
})
