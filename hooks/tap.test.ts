import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, TurnStepChunk } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { STEP, WITH_PROBE, answerBelow, beneath, complete, drain, probe } from './testkit'

const THINK_THEN_TOOL: TurnStepChunk[] = [
  { kind: 'thinking', index: 0, text: 'weighing the ' },
  { kind: 'thinking', index: 0, text: 'band placement' },
  { kind: 'tool', index: 1, id: 'tu1', name: 'Bash' },
  { kind: 'stop', stopReason: 'tool_use', usage: null },
]


test('passes every chunk through unchanged, in order', async ($, on) => {
  mock.clock(on)
  beneath(on, THINK_THEN_TOOL)
  const out: TurnStepChunk[] = []
  for await (const c of $.turn.step(STEP)) out.push(c)
  expect(out).toEqual(THINK_THEN_TOOL)
})

test('a step read to its end returns the result from beneath unchanged', async ($, on) => {
  mock.clock(on)
  const toolUses = [{ name: 'Read', input: { file_path: '/repo/hooks/rows.ts' } }]
  beneath(on, { chunks: THINK_THEN_TOOL, toolUses })
  const stream = $.turn.step(STEP)
  let step = await stream.next()
  while (!step.done) step = await stream.next()
  expect(step.value).toEqual({ turnId: 't1', index: 0, answer: '', toolUses, stopReason: 'end_turn', usage: null })
})

test('a step closed early closes the stream beneath', async ($, on) => {
  mock.clock(on)
  let closed = false
  on('turn.step', async function* (_$, e) {
    try {
      yield* THINK_THEN_TOOL
    } finally {
      closed = true
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  for await (const _ of $.turn.step(STEP)) break
  expect(closed).toBe(true)
})

/** The tool call `THINK_THEN_TOOL` streams, as the step's result reports it. */
const BASH = [{ name: 'Bash', input: {} }]

test('a step records its phases and counts its block and tool: tool time starts when its stream ends', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, { chunks: THINK_THEN_TOOL, toolUses: BASH })
  await drain($.turn.step(STEP))
  const t = await probe($)
  expect(t?.spans.map(s => s.phase)).toEqual(['wait', 'think', 'write', 'tool'])
  expect(t).toMatchObject({ blocks: 1, tools: 1 })
})

test('a step with several tool calls writes them all, then runs them in one tool phase', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, {
    chunks: [
      { kind: 'tool', index: 0, id: 'tu1', name: 'Read' },
      { kind: 'input', index: 0, json: '{}' },
      { kind: 'tool', index: 1, id: 'tu2', name: 'Bash' },
      { kind: 'input', index: 1, json: '{}' },
    ],
    toolUses: [{ name: 'Read', input: {} }, ...BASH],
  })
  await drain($.turn.step(STEP))
  const t = await probe($)
  expect(t?.spans.map(s => s.phase)).toEqual(['wait', 'write', 'tool'])
  expect(t?.tools).toBe(2)
})

test('a step whose result names no tool calls never enters the tool phase, though a tool chunk streamed', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, THINK_THEN_TOOL)
  await drain($.turn.step(STEP))
  expect((await probe($))?.spans.map(s => s.phase)).toEqual(['wait', 'think', 'write'])
})

test('a step whose stream reported no tool chunk still enters the tool phase for the calls its result names', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, { chunks: [], toolUses: BASH })
  await drain($.turn.step(STEP))
  expect((await probe($))?.spans.map(s => s.phase)).toEqual(['wait', 'tool'])
})

test('a later step starts by waiting on the model again, which ends the tool phase', WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, { chunks: THINK_THEN_TOOL, toolUses: BASH }, [{ kind: 'text', index: 0, text: 'done' }])
  await drain($.turn.step(STEP))
  await drain($.turn.step({ ...STEP, index: 1 }))
  expect((await probe($))?.spans.map(s => s.phase)).toEqual(['wait', 'think', 'write', 'tool', 'wait', 'write'])
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
    { kind: 'thinking', index: 0, text: 'Row` now. Actually, ' },
  ])
  await drain($.turn.step(STEP))
  expect(await probe($)).toMatchObject({ focus: [{ t: 'metaRow', n: 1 }], hedges: 1 })
})

test("a step's tool calls count toward focus, with no thinking text", WITH_PROBE, async ($, on) => {
  mock.clock(on)
  beneath(on, {
    chunks: [
      { kind: 'thinking', index: 0, text: '' },
      { kind: 'tool', index: 1, id: 'tu1', name: 'Read' },
      { kind: 'tool', index: 2, id: 'tu2', name: 'Edit' },
    ],
    toolUses: [
      { name: 'Read', input: { file_path: '/repo/hooks/lib.ts' } },
      { name: 'Edit', input: { file_path: '/repo/hooks/lib.ts', old_string: 'fooBar', new_string: 'bazQux' } },
    ],
  })
  await drain($.turn.step(STEP))
  expect(await probe($)).toMatchObject({ focus: [{ t: 'lib.ts', n: 2 }], hedges: 0 })
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

/** The engine's own Spinner: its word as text. */
function engineSpinner(on: On) {
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.word) as RenderElement
  })
}

const SPINNER = { word: 'Cooking', message: null, suffix: '…', mode: 'requesting' } as RenderPropsOf['Spinner']
const spinner = ($: Engine) => $.ui.mount({ plugin: 'dreeft', surface: 'terminal', component: 'Spinner', props: SPINNER })

test('the spinner mode opens phases the chunk stream misses on the next tick, and the spinner draws unchanged', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  engineSpinner(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  await drain($.turn.step(STEP))
  const view = await spinner($)
  await view.redraw({ ...SPINNER, mode: 'thinking' })
  await clock.advance(1000)
  await view.redraw({ ...SPINNER, mode: 'tool-use' })
  await clock.advance(1000)
  // Only the mode the spinner shows at a tick counts: the opening `requesting` was redrawn before one.
  expect((await probe($))?.spans.map(s => s.phase)).toEqual(['wait', 'write', 'think', 'tool'])
  expect(await view.find({ text: 'Cooking' })).toBeDefined()
})

test('the spinner changes nothing once the turn is done, or before any turn', WITH_PROBE, async ($, on) => {
  const clock = mock.clock(on)
  engineSpinner(on)
  answerBelow(on)
  beneath(on, [{ kind: 'text', index: 0, text: 'ok' }])
  const view = await spinner($)
  await view.redraw({ ...SPINNER, mode: 'thinking' })
  await clock.advance(1000)
  expect(await probe($)).toBeNull()
  await drain($.turn.step(STEP))
  await complete($, {})
  const spans = (await probe($))?.spans
  await view.redraw({ ...SPINNER, mode: 'tool-use' })
  await clock.advance(2000)
  expect((await probe($))?.spans).toEqual(spans)
})
