import { expect, mock, test } from 'claude-code/testing'
import type { TurnStepChunk } from 'claude-code'

import { PROBE, STEP, answerBelow, beneath, complete, drain, probe } from './testkit'

const THINK_THEN_TOOL: TurnStepChunk[] = [
  { kind: 'thinking', index: 0, text: 'weighing the ' },
  { kind: 'thinking', index: 0, text: 'band placement' },
  { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' },
  { kind: 'stop', stopReason: 'tool_use', usage: null },
]

const WITH_PROBE = { plugins: [PROBE] }

test('passes every chunk through unchanged, in order', async ($, on) => {
  mock.clock(on)
  beneath(on, THINK_THEN_TOOL)
  const out: TurnStepChunk[] = []
  for await (const c of $.turn.step(STEP)) out.push(c)
  expect(out).toEqual(THINK_THEN_TOOL)
})

test('a step records its phases and counts its block and tool', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, THINK_THEN_TOOL)
  await drain($.turn.step(STEP))
  const t = await probe($)
  expect(t?.spans.map(s => s.phase)).toEqual(['wait', 'think', 'tool'])
  expect(t).toMatchObject({ blocks: 1, tools: 1 })
})

test('a later step starts by waiting on the model again', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, THINK_THEN_TOOL, [{ kind: 'text', index: 0, text: 'done' }])
  await drain($.turn.step(STEP))
  await drain($.turn.step({ ...STEP, index: 1 }))
  expect((await probe($))?.spans.map(s => s.phase)).toEqual(['wait', 'think', 'tool', 'wait', 'write'])
})

test('the ticker moves the clock on between steps and stops at turn.complete', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  answerBelow(on)
  beneath(on, THINK_THEN_TOOL)
  await drain($.turn.step(STEP))
  const started = (await probe($))?.started ?? 0
  await clock.advance(3000)
  expect(((await probe($))?.now ?? 0) - started).toBe(3000)
  await complete($, {})
  await clock.advance(5000)
  expect(((await probe($))?.now ?? 0) - started).toBe(3000)
})

test('a name split across chunks still counts toward focus', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, [
    { kind: 'thinking', index: 0, text: 'look at `meta' },
    { kind: 'thinking', index: 0, text: 'Row` now, actually ' },
  ])
  await drain($.turn.step(STEP))
  expect(await probe($)).toMatchObject({ focus: [{ t: 'metaRow', n: 1 }], hedges: 1 })
})

test('subagent steps never touch state', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, THINK_THEN_TOOL)
  await drain($.turn.step({ ...STEP, agentId: 'sub1' }))
  expect(await probe($)).toBeNull()
})

test('step 0 of a new turn starts a fresh turn', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, [{ kind: 'thinking', index: 0, text: 'uses `oldName` ' }], [{ kind: 'text', index: 0, text: 'hi' }])
  await drain($.turn.step(STEP))
  expect((await probe($))?.focus).toHaveLength(1)
  await drain($.turn.step({ ...STEP, turnId: 't2' }))
  const t = await probe($)
  expect(t?.focus).toEqual([])
  expect(t?.spans.map(s => s.phase)).toEqual(['wait', 'write'])
})
