import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextUsage, TurnStepChunk } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { PROBE, STEP, answerBelow, beneath, complete, drain, measure, probe } from './testkit'

const WITH_PROBE = { plugins: [PROBE] }

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
  { kind: 'stop', stopReason: 'tool_use', usage: { model: 'm', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
]

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
