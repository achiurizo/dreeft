import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextUsage, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { STEP, WITH_PROBE, answerBelow, beneath, complete, drain, measure, probe, stop } from './testkit'


/** Stands for the status line's figures beneath the mod. */
function usageBelow(on: On, context: SessionContextUsage) {
  on('session.usage', async () => ({ value: { startedAt: 0, context, rateLimits: [] } }))
}

function sessionBelow(on: On) {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
}

function startSession($: Engine) {
  return $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

test('with no measure yet, step 0 seeds context from session usage, so growth lands', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  usageBelow(on, { tokens: 100_000, window: 1_000_000 })
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  expect(await probe($, 'ctx')).toEqual({ tokens: 100_000, window: 1_000_000, lastInput: null })
  expect(await probe($, 'turn')).toMatchObject({ startTokens: 100_000, window: 1_000_000 })
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  expect(await probe($, 'turn')).toMatchObject({ done: true, final: 0.6 })
  expect(await probe($, 'trail')).toEqual([0.6])
})

test('session usage with no tokens seeds nothing', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  usageBelow(on, { window: 1_000_000 })
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  expect(await probe($, 'ctx')).toBeNull()
  expect(await probe($, 'turn')).toMatchObject({ startTokens: null, window: 0 })
})

test('session usage with a zero window seeds nothing', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  usageBelow(on, { tokens: 100_000, window: 0 })
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  expect(await probe($, 'ctx')).toBeNull()
  expect(await probe($, 'turn')).toMatchObject({ startTokens: null, window: 0 })
})

test('a throwing session usage still starts the turn', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  on('session.usage', async () => {
    throw new Error('no status line')
  })
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  expect(await probe($, 'ctx')).toBeNull()
  expect(await probe($, 'turn')).toMatchObject({ done: false, startTokens: null })
})

test('session.start mid-turn keeps the ticker moving the clock on', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  sessionBelow(on)
  beneath(on, [{ kind: 'tool', index: 0, id: 'tu1', name: 'Bash' }])
  await drain($.turn.step(STEP))
  const started = (await probe($))?.started ?? 0
  await startSession($)
  await clock.advance(3000)
  expect(((await probe($))?.now ?? 0) - started).toBe(3000)
})

test('session.start after a done turn starts no ticker', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  answerBelow(on)
  sessionBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  await complete($, {})
  const before = await probe($)
  await startSession($)
  await clock.advance(5000)
  expect(await probe($)).toEqual(before)
})

const CHUNKS: TurnStepChunk[] = [
  { kind: 'thinking', index: 0, text: 'weighing `metaRow`' },
  { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' },
  stop('tool_use', 1, 2),
]

test('a tool\'s streamed arguments cost no state write', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  let writes = 0
  on('state.set', async (_$, e, next) => {
    writes++
    return next(e)
  })
  const input: TurnStepChunk[] = Array.from({ length: 50 }, () => ({ kind: 'input', index: 1, json: '{"a":' }))
  const tool: TurnStepChunk = { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' }
  beneath(on, [tool], [tool, ...input])
  await drain($.turn.step(STEP))
  const without = writes
  writes = 0
  await drain($.turn.step(STEP))
  expect(writes).toBe(without)
  expect(await probe($)).toMatchObject({ tools: 1 })
})

test('the tool phase costs one state write when a step with tool calls ends, and none when it has no calls', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  let writes = 0
  on('state.set', async (_$, e, next) => {
    writes++
    return next(e)
  })
  const tool: TurnStepChunk = { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' }
  // Empty arguments name nothing, so the focus write stays out of the count.
  beneath(on, [tool], { chunks: [tool], toolUses: [{ name: 'Bash', input: {} }] })
  await drain($.turn.step(STEP))
  const without = writes
  writes = 0
  await drain($.turn.step(STEP))
  expect(writes).toBe(without + 1)
  expect((await probe($))?.spans.at(-1)?.phase).toBe('tool')
})

test('when every state write throws, steps still pass each chunk through and turn.complete still answers', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  // A hook that throws is skipped and the write still lands; core refuses an undefined value, so the write rejects.
  on('state.set', async (_$, e, next) => next(Object.assign({}, e, { value: undefined })))
  beneath(on, CHUNKS, {
    chunks: [{ kind: 'text', index: 0, text: 'done' }],
    toolUses: [{ name: 'Read', input: { file_path: '/repo/hooks/lib.ts' } }],
  })
  await measure($, 100_000, 1_000_000)
  const first: TurnStepChunk[] = []
  for await (const c of $.turn.step(STEP)) first.push(c)
  expect(first).toEqual(CHUNKS)
  const second: TurnStepChunk[] = []
  for await (const c of $.turn.step({ ...STEP, index: 1 })) second.push(c)
  expect(second).toEqual([{ kind: 'text', index: 0, text: 'done' }])
  expect(await complete($, {})).toEqual({ text: '' })
  expect(await probe($)).toBeNull()
})

test('a null tool call in a step result costs neither the stream, the result, nor the other calls\' focus names', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  const read = { name: 'Read', input: { file_path: '/repo/hooks/lib.ts' } }
  // Parsed, as a plugin beneath hands it up: the engine checks that `toolUses` is there, not what it holds.
  const result: TurnStepResult = JSON.parse(JSON.stringify({ turnId: 't1', index: 0, answer: '', toolUses: [null, read, read], stopReason: 'tool_use', usage: null }))
  on('turn.step', async function* () {
    yield* CHUNKS
    return result
  })
  const out: TurnStepChunk[] = []
  const stream = $.turn.step(STEP)
  let step = await stream.next()
  while (!step.done) {
    out.push(step.value)
    step = await stream.next()
  }
  expect(out).toEqual(CHUNKS)
  expect(step.value).toEqual(result)
  expect((await probe($))?.focus).toEqual([{ t: 'metaRow', n: 1 }, { t: 'lib.ts', n: 2 }])
})

test('when state writes start failing mid-turn, session.start and session.compact still pass through', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  sessionBelow(on)
  const messages = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
  on('session.compact', async () => ({ messages }))
  let failing = false
  on('state.set', async (_$, e, next) => next(failing ? Object.assign({}, e, { value: undefined }) : e))
  beneath(on, [{ kind: 'tool', index: 0, id: 'tu1', name: 'Bash' }])
  await drain($.turn.step(STEP))
  const before = await probe($)
  failing = true
  // The turn is still running, so session.start restarts the ticker and each tick's write fails too.
  expect(await startSession($)).toEqual({ cwd: '/repo' })
  expect(await $.session.compact({ trigger: 'manual', messages })).toEqual({ messages })
  await clock.advance(2000)
  expect(await probe($)).toEqual(before)
  expect(await probe($, 'trail')).toBeNull()
})

test('with steer on and the coin firing, a session.append that throws leaves every chunk, the step result and turn.complete unchanged', { options: { steer: 'on' }, plugins: WITH_PROBE.plugins }, async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  answerBelow(on)
  const logged: string[] = []
  on('ui.log', async (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  // `steer.test.ts` pins this session's coin for turn t1 at 10 points on the firing side.
  on('session.id', async () => ({ value: 's7' }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // Nothing answers `session.append`: the kit has no conversation, so the mod's append rejects.
  const chunks: TurnStepChunk[] = [{ kind: 'tool', index: 0, id: 'tu1', name: 'Read' }, stop('tool_use', 220_000, 0)]
  const toolUses = [{ name: 'Read', input: { file_path: '/repo/hooks/lib.ts' } }]
  beneath(on, { chunks, toolUses })
  await measure($, 100_000, 1_000_000)
  const out: TurnStepChunk[] = []
  const stream = $.turn.step(STEP)
  let step = await stream.next()
  while (!step.done) {
    out.push(step.value)
    step = await stream.next()
  }
  expect(out).toEqual(chunks)
  expect(step.value).toEqual({ turnId: 't1', index: 0, answer: '', toolUses, stopReason: 'end_turn', usage: null })
  expect(await complete($, { answer: 'Done.' })).toEqual({ text: 'Done.' })
  expect(logged).toEqual([expect.stringContaining('steer: the user row was not appended')])
  // The band's turn went on as any other: the tool phase, the growth, no nudge.
  expect(await probe($)).toMatchObject({ done: true, final: 12, nudges: [], triggers: 1 })
})
