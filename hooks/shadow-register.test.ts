import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteRequest, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { ShadowRecord } from './shadow'
import { STEP, answerBelow, beneath, complete, drain } from './testkit'

const ON = { options: { memoryShadow: 'on' } }
const USAGE = { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const THINKING = 'Actually, the engine never hands tool results to turn.step chunks at all.'
const KEEP = '{"verdicts":[{"i":0,"verdict":"keep","fact":"whispered-thoughts: tool results reach tool.call only.","type":"project","name":"tool-results-in-tool-call","topic":"context-whispered-thoughts","keywords":["tool.call"],"importance":"high","reason":"gotcha"}]}'

/** The world beneath the mod: the model, the shell, the session; records what the mod asked of them. */
function world(on: On) {
  const asked: ModelCompleteRequest[] = []
  const appended: string[] = []
  const argvs: string[][] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-02T00:00:00Z') })
  mock.env(on, { HOME: '/home/u' })
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
    return { value: { isAnswered: true, text: KEEP, usage: USAGE } }
  })
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('--git-common-dir')) return out('/repo/.git\n')
    if (e.argv.includes('get-url')) return out('https://tok@github.com/a/b.git\n')
    if (e.argv[0] === '/bin/sh') appended.push(e.init?.stdin ?? '')
    return out('')
  })
  return { asked, appended, argvs, clock, logged }
}

async function turnWith($: Engine, on: On, thinking: string) {
  beneath(on, [{ kind: 'thinking', index: 0, text: thinking }, { kind: 'text', index: 1, text: 'Done.' }])
  await drain($.turn.step(STEP))
}

test('a turn with a candidate: one judge call, one record per candidate appended to the log', ON, async ($, on) => {
  const w = world(on)
  await turnWith($, on, THINKING)
  await complete($, { answer: 'Done.' })
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.model).toBe('claude-haiku-4-5-20251001')
  expect(w.argvs.find(a => a[0] === '/bin/sh')).toEqual(['/bin/sh', '-c', 'mkdir -p "$1" && cat >> "$1/$2"', 'sh', '/home/u/.local/state/whispered-thoughts', 'memory-shadow.jsonl'])
  // Shadow mode only: git lookups and the log append, never icm or the flush staging queue.
  expect(w.argvs.map(a => a[0] === '/bin/sh' ? 'sh' : a.slice(0, 1).join(''))).toEqual(['git', 'git', 'sh'])
  const records: ShadowRecord[] = w.appended.join('').trim().split('\n').map(l => JSON.parse(l))
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    schema: 1, ts: '2026-10-02T00:00:00.000Z', session: expect.any(String), turn: 't1', project: 'https://github.com/a/b.git', root: '/repo',
    source: 'hedge', span: THINKING, confirmed: false, verdict: 'keep', topic: 'context-whispered-thoughts', importance: 'high',
    judge: { model: 'claude-haiku-4-5-20251001', candidates: 1, input_tokens: 900, output_tokens: 80 },
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

test('an aborted turn or a subagent turn is skipped', ON, async ($, on) => {
  const w = world(on)
  await turnWith($, on, THINKING)
  await complete($, { isAborted: true, reason: 'aborted' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'sub1' })
  await w.clock.settle()
  expect(w.asked).toHaveLength(0)
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
  const [record] = w.appended.join('').trim().split('\n').map((l): ShadowRecord => JSON.parse(l))
  expect(record).toMatchObject({ source: 'hedge', confirmed: true, evidence: { from: 'tool', tool: 'Bash', snippet: out } })
})
