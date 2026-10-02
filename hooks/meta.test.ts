import { expect, mock, test } from 'claude-code/testing'
import type { TurnStepChunk } from 'claude-code'

import { PROBE, STEP, answerBelow, beneath, complete, drain, measure, probe } from './testkit'

const WITH_PROBE = { plugins: [PROBE] }
const STOP = (output_tokens: number): TurnStepChunk => ({
  kind: 'stop', stopReason: 'tool_use',
  usage: { model: 'm', input_tokens: 1, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

test('step 0 snapshots context; blocks, think time and output tokens accumulate', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  answerBelow(on)
  beneath(on,
    [{ kind: 'thinking', index: 0, text: 'a' }, { kind: 'tool', index: 1, id: 't', name: 'Bash' }, STOP(400)],
    [{ kind: 'thinking', index: 0, text: 'b' }, { kind: 'text', index: 1, text: 'ok' }, STOP(600)],
  )
  await measure($, 100_000, 1_000_000)
  const s0 = $.turn.step(STEP)
  await s0.next()
  await clock.advance(2000)
  await drain(s0)
  const s1 = $.turn.step({ ...STEP, index: 1 })
  await s1.next()
  await clock.advance(1000)
  await drain(s1)
  expect(await probe($, 'turn')).toMatchObject({ blocks: 2, thinkMs: 3000, outTok: 1000, startTokens: 100_000, window: 1_000_000, done: false })
})

test('turn.complete pushes growth onto the trail and freezes the turn', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  expect(await probe($, 'trail')).toEqual([0.6])
  expect(await probe($, 'turn')).toMatchObject({ done: true, final: 0.6 })
})

test('no measurement yet: growth stays null and the trail is untouched', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  await complete($, {})
  expect((await probe($, 'trail')) ?? []).toEqual([])
  expect(await probe($, 'turn')).toMatchObject({ done: true, final: null })
})

test('a subagent turn.complete never touches the trail', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 150_000, 1_000_000)
  await complete($, { agentId: 'sub1' })
  expect((await probe($, 'trail')) ?? []).toEqual([])
})

const USAGE = (input: number, output: number): TurnStepChunk => ({
  kind: 'stop', stopReason: 'end_turn',
  usage: { model: 'm', input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

test('context tracks each step live from stop usage, output included', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'tool', index: 0, id: 't', name: 'Bash' }, USAGE(100_000, 2_000)])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  expect(await probe($, 'ctx')).toMatchObject({ tokens: 102_000, window: 1_000_000 })
})

test('a late measure for the same response is ignored', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }, USAGE(100_000, 2_000)])
  await measure($, 90_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 100_000, 1_000_000)
  expect((await probe($, 'ctx'))?.tokens).toBe(102_000)
})

test('a measure with different tokens (compaction) is adopted', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }, USAGE(100_000, 2_000)])
  await measure($, 90_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 40_000, 1_000_000)
  expect((await probe($, 'ctx'))?.tokens).toBe(40_000)
})

test('final growth includes the turn\'s own last answer, even if measure lands after complete', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }, USAGE(104_000, 3_000)])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  await complete($, {})
  await measure($, 104_000, 1_000_000)
  expect(await probe($, 'turn')).toMatchObject({ final: 0.7 })
  expect(await probe($, 'trail')).toEqual([0.7])
})

test('a turn.complete with no new step 0 leaves the previous turn alone', WITH_PROBE, async ($, on) => {
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  await measure($, 120_000, 1_000_000)
  await complete($, { turnId: 't2' })
  expect(await probe($, 'trail')).toEqual([0.6])
  expect(await probe($, 'turn')).toMatchObject({ final: 0.6 })
})
