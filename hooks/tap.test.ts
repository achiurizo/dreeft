import { expect, mock, test } from 'claude-code/testing'
import type { TurnStepChunk } from 'claude-code'

import { PROBE, STEP, beneath, drain, probe } from './testkit'

const THINK_THEN_TOOL: TurnStepChunk[] = [
  { kind: 'thinking', index: 0, text: 'weighing the ' },
  { kind: 'thinking', index: 0, text: 'band placement' },
  { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' },
  { kind: 'stop', stopReason: 'tool_use', usage: null },
]

const WITH_PROBE = { plugins: [PROBE] }

test('passes every chunk through unchanged, in order', async ($, on) => {
  beneath(on, THINK_THEN_TOOL)
  const out: TurnStepChunk[] = []
  for await (const c of $.turn.step(STEP)) out.push(c)
  expect(out).toEqual(THINK_THEN_TOOL)
})

test('thinking sets live and tail; a tool chunk freezes', WITH_PROBE, async ($, on) => {
  beneath(on, THINK_THEN_TOOL)
  const stream = $.turn.step(STEP)
  await stream.next()
  await stream.next()
  expect(await probe($)).toMatchObject({ tail: 'weighing the band placement', live: true })
  await stream.next()
  expect(await probe($)).toMatchObject({ tail: 'weighing the band placement', live: false })
  await drain(stream)
})

test('clock advances phase only while live', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, THINK_THEN_TOOL)
  const stream = $.turn.step(STEP)
  await stream.next()
  await clock.advance(80 * 3)
  expect((await probe($))?.phase).toBe(3)
  await stream.next()
  await stream.next()
  await clock.advance(80 * 5)
  expect((await probe($))?.phase).toBe(3)
  await drain(stream)
})

test('closing the stream mid-thinking (Esc) stops the clock and freezes', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  beneath(on, THINK_THEN_TOOL)
  const stream = $.turn.step(STEP)
  await stream.next()
  await clock.advance(80)
  await stream.return(undefined as never)
  expect(await probe($)).toMatchObject({ live: false, phase: 1 })
  await clock.advance(80 * 5)
  expect((await probe($))?.phase).toBe(1)
})

test('subagent steps never touch state', WITH_PROBE, async ($, on) => {
  beneath(on, THINK_THEN_TOOL)
  await drain($.turn.step({ ...STEP, agentId: 'sub1' }))
  expect((await probe($))?.tail ?? '').toBe('')
})

test('a later block in the same turn keeps the previous one before a separator', WITH_PROBE, async ($, on) => {
  beneath(
    on,
    [{ kind: 'thinking', index: 0, text: 'first' }, { kind: 'text', index: 1, text: 'ok' }],
    [{ kind: 'thinking', index: 0, text: 'second' }],
  )
  await drain($.turn.step(STEP))
  const stream = $.turn.step({ ...STEP, index: 1 })
  await stream.next()
  expect((await probe($))?.tail).toBe('first ┊ second')
  await drain(stream)
})

test('step 0 of a new turn clears the previous frozen tail', WITH_PROBE, async ($, on) => {
  beneath(
    on,
    [{ kind: 'thinking', index: 0, text: 'old' }, { kind: 'text', index: 1, text: 'x' }],
    [{ kind: 'text', index: 0, text: 'hi' }],
  )
  await drain($.turn.step(STEP))
  expect((await probe($))?.tail).toBe('old')
  const stream = $.turn.step({ ...STEP, turnId: 't2' })
  await stream.next()
  expect((await probe($))?.tail ?? '').toBe('')
  await drain(stream)
})

const HIDE = { options: { hideThinkingInTranscript: true } }

test('hideThinkingInTranscript: thinking is not passed on, everything else is, in order', HIDE, async ($, on) => {
  beneath(on, THINK_THEN_TOOL)
  const out: TurnStepChunk[] = []
  for await (const c of $.turn.step(STEP)) out.push(c)
  expect(out).toEqual(THINK_THEN_TOOL.filter(c => c.kind !== 'thinking'))
})

test('hideThinkingInTranscript: the band still gets the tail', { ...HIDE, ...WITH_PROBE }, async ($, on) => {
  beneath(on, THINK_THEN_TOOL)
  await drain($.turn.step(STEP))
  expect(await probe($)).toMatchObject({ tail: 'weighing the band placement', live: false })
})

test('hideThinkingInTranscript: subagent thinking still passes through', HIDE, async ($, on) => {
  beneath(on, THINK_THEN_TOOL)
  const out: TurnStepChunk[] = []
  for await (const c of $.turn.step({ ...STEP, agentId: 'sub1' })) out.push(c)
  expect(out).toEqual(THINK_THEN_TOOL)
})

test('off by default: thinking passes through', async ($, on) => {
  beneath(on, THINK_THEN_TOOL)
  const out: TurnStepChunk[] = []
  for await (const c of $.turn.step(STEP)) out.push(c)
  expect(out.filter(c => c.kind === 'thinking')).toHaveLength(2)
})
