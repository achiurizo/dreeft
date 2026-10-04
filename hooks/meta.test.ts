import { expect, mock, test } from 'claude-code/testing'

import { phaseTotals } from './turn'
import { STEP, WITH_PROBE, answerBelow, beneath, complete, drain, measure, probe, stop } from './testkit'

test('step 0 snapshots context; blocks and think time accumulate', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  answerBelow(on)
  beneath(on,
    [{ kind: 'thinking', index: 0, text: 'a' }, { kind: 'tool', index: 1, id: 't', name: 'Bash' }, stop('tool_use', 1, 400)],
    [{ kind: 'thinking', index: 0, text: 'b' }, { kind: 'text', index: 1, text: 'ok' }, stop('tool_use', 1, 600)],
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
  const t = await probe($, 'turn')
  expect(t).toMatchObject({ blocks: 2, tools: 1, startTokens: 100_000, window: 1_000_000, done: false })
  expect(t && phaseTotals(t.spans, t.now).think).toBe(3000)
})

test('turn.complete pushes growth onto the trail and freezes the turn', WITH_PROBE, async ($, on) => {
  mock.clock(on)
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
  mock.clock(on)
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  await complete($, {})
  expect((await probe($, 'trail')) ?? []).toEqual([])
  expect(await probe($, 'turn')).toMatchObject({ done: true, final: null })
})

test('a subagent turn.complete never touches the trail', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 150_000, 1_000_000)
  await complete($, { agentId: 'sub1' })
  expect((await probe($, 'trail')) ?? []).toEqual([])
})

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

test('a main-loop compaction marks the trail', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  on('session.compact', async () => ({ messages: SUMMARY, tokensBefore: 800_000, tokensAfter: 40_000 }))
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(await probe($, 'trail')).toEqual([0.6, null])
})

test('a precompute, a skipped compaction or a subagent compaction leaves the trail alone', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  on('session.compact', async (_$, e) => (e.trigger === 'auto' ? { skip: 'vetoed' } : { messages: SUMMARY }))
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  await $.session.compact({ trigger: 'manual', agentId: 'sub1', messages: SUMMARY })
  expect((await probe($, 'trail')) ?? []).toEqual([])
})

test('context tracks each step live from stop usage, output included', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  beneath(on, [{ kind: 'tool', index: 0, id: 't', name: 'Bash' }, stop('end_turn', 100_000, 2_000)])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  expect(await probe($, 'ctx')).toMatchObject({ tokens: 102_000, window: 1_000_000 })
})

test('context counts cached input along with fresh input', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }, stop('end_turn', 1_000, 2_000, { read: 90_000, creation: 9_000 })])
  await measure($, 90_000, 1_000_000)
  await drain($.turn.step(STEP))
  expect(await probe($, 'ctx')).toMatchObject({ tokens: 102_000, lastInput: 100_000 })
})

test('a late measure for the same response is ignored', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }, stop('end_turn', 100_000, 2_000)])
  await measure($, 90_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 100_000, 1_000_000)
  expect((await probe($, 'ctx'))?.tokens).toBe(102_000)
})

test('a measure with different tokens (compaction) is adopted', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }, stop('end_turn', 100_000, 2_000)])
  await measure($, 90_000, 1_000_000)
  await drain($.turn.step(STEP))
  await measure($, 40_000, 1_000_000)
  expect((await probe($, 'ctx'))?.tokens).toBe(40_000)
})

test('final growth includes the turn\'s own last answer, even if measure lands after complete', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }, stop('end_turn', 104_000, 3_000)])
  await measure($, 100_000, 1_000_000)
  await drain($.turn.step(STEP))
  await complete($, {})
  await measure($, 104_000, 1_000_000)
  expect(await probe($, 'turn')).toMatchObject({ final: 0.7 })
  expect(await probe($, 'trail')).toEqual([0.7])
})

test('a turn.complete with no new step 0 leaves the previous turn alone', WITH_PROBE, async ($, on) => {
  mock.clock(on)
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

