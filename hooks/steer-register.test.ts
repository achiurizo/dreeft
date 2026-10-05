import { expect, mock, test } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStepToolUse } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { nudgeText } from './steer'
import type { OutcomeRecord, TriggerRecord } from './steer'
import { PROBE, STEP, answerBelow, beneath, complete, drain, measure, probe, stop } from './testkit'

const ON = { options: { steer: 'on' }, plugins: [PROBE] }
const SHADOW = { options: { steer: 'shadow' }, plugins: [PROBE] }
const START = Date.parse('2026-10-04T00:00:00Z')
/** Session ids on each side of the coin flip, for turn `t1` at both thresholds: `steer.test.ts` pins their numbers. */
const FIRES = 's7'
const HOLDS = 's1'

/**
 * What the debug log holds for one attempt to append a row. The kit has no conversation beneath the mod:
 * a mod's own `$.session.append` rejects there and reaches no hook, the test's included. So a test
 * counts the attempts by their failures, and cannot play a row that was stored or one a plugin refused.
 */
const attempt = (type: 'user' | 'system') => expect.stringContaining(`steer: the ${type} row was not appended`)

/** The world beneath the mod: the shell and the session; records what the mod asked of them. */
function world(on: On, session: string, over: { appendExit?: number } = {}) {
  const lines: string[] = []
  const argvs: string[][] = []
  const logged: string[] = []
  const asked: string[] = []
  const clock = mock.clock(on, { now: START })
  mock.env(on, { HOME: '/home/u' })
  answerBelow(on)
  on('ui.log', async (_$, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('session.id', async () => {
    asked.push('session.id')
    return { value: session }
  })
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    if (!over.appendExit) lines.push(e.init?.stdin ?? '')
    return { value: { exitCode: over.appendExit ?? 0, stdout: '', stderr: over.appendExit ? 'No space left on device' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const records = (): (TriggerRecord | OutcomeRecord)[] => lines.join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { argvs, logged, asked, clock, records }
}

const TOOL: TurnStepChunk = { kind: 'tool', index: 0, id: 'tu1', name: 'Read' }
/** A step that calls `names` and leaves the context at `tokens`. */
const calls = (tokens: number, ...names: string[]): { chunks: TurnStepChunk[]; toolUses: TurnStepToolUse[] } => ({
  chunks: [TOOL, stop('tool_use', tokens, 0)],
  toolUses: names.map(name => ({ name, input: {} })),
})
/** A final step: text and no tool call. */
const answers = (tokens: number): TurnStepChunk[] => [{ kind: 'text', index: 0, text: 'Done.' }, stop('end_turn', tokens, 0)]
const step = ($: Engine, index: number) => drain($.turn.step({ ...STEP, index }))
/** A turn that starts at 100k of a 1M window: 220k is 12 points of growth. */
const start = ($: Engine) => measure($, 100_000, 1_000_000)

test('on, and the coin fires: crossing 10 points at a step with tool calls tries the model\'s row once, and logs the fire with its text', ON, async ($, on) => {
  const w = world(on, FIRES)
  beneath(on, calls(220_000, 'Read'))
  await start($)
  await w.clock.advance(3000)
  await step($, 0)
  await w.clock.settle()
  // One attempt at the user row; with that row not stored, no notice claims a nudge the model never got.
  expect(w.logged).toEqual([attempt('user')])
  expect(await probe($)).toMatchObject({ nudges: [], triggers: 1 })
  expect(w.argvs).toEqual([[expect.any(String), '-c', expect.any(String), 'sh', '/home/u/.local/state/dreeft', 'steer.jsonl']])
  expect(w.records()).toEqual([
    { schema: 1, kind: 'trigger', rev: 1, ts: '2026-10-04T00:00:03.000Z', session: FIRES, turn: 't1', step: 0, threshold: 10, growth: 12, mode: 'on', arm: 'fire', sent: false, text: nudgeText(12) },
  ])
})

test('on, and the coin holds: no row is tried, the band keeps no nudge, and a hold is logged', ON, async ($, on) => {
  const w = world(on, HOLDS)
  beneath(on, calls(220_000, 'Read'))
  await start($)
  await step($, 0)
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(await probe($)).toMatchObject({ nudges: [], triggers: 1 })
  expect(w.records()).toMatchObject([{ kind: 'trigger', threshold: 10, growth: 12, mode: 'on', arm: 'hold', sent: false, text: null }])
})

for (const random of [FIRES, HOLDS]) {
  test(`shadow tries no row and logs a hold, with a session whose coin ${random === FIRES ? 'fires' : 'holds'}`, SHADOW, async ($, on) => {
    const w = world(on, random)
    beneath(on, calls(220_000, 'Read'))
    await start($)
    await step($, 0)
    await w.clock.settle()
    expect(w.logged).toEqual([])
    expect(await probe($)).toMatchObject({ nudges: [], triggers: 1 })
    expect(w.records()).toMatchObject([{ kind: 'trigger', mode: 'shadow', arm: 'hold', sent: false, text: null }])
  })
}

for (const [name, options] of [['by default', {}], ['with steer off', { steer: 'off' }], ['with an unknown steer value', { steer: 'ON' }]] as const) {
  test(`${name}, a step that crosses 10 points tries no row, logs nothing, and does no more work than one that does not`, { options, plugins: [PROBE] }, async ($, on) => {
    const w = world(on, FIRES)
    const ops: string[] = []
    on('state.get', async (_$, e, next) => {
      ops.push('get')
      return next(e)
    })
    on('state.set', async (_$, e, next) => {
      ops.push('set')
      return next(e)
    })
    beneath(on, calls(150_000, 'Read'), calls(160_000, 'Read'), calls(220_000, 'Read'), answers(230_000))
    await start($)
    await step($, 0)
    ops.length = 0
    await step($, 1)
    const under = ops.splice(0)
    // The same step shape again, now past 10 points of growth.
    await step($, 1)
    const over = ops.splice(0)
    await step($, 2)
    await complete($, {})
    await w.clock.settle()
    expect(over).toEqual(under)
    expect(under.length).toBeGreaterThan(0)
    expect(w.logged).toEqual([])
    expect(w.argvs).toEqual([])
    expect(w.asked).toEqual([])
    expect(await probe($)).toMatchObject({ nudges: [], triggers: 0, done: true })
  })
}

test('the final step never triggers, whatever the growth', ON, async ($, on) => {
  const w = world(on, FIRES)
  beneath(on, answers(400_000))
  await start($)
  await step($, 0)
  await complete($, {})
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(w.argvs).toEqual([])
  expect(await probe($)).toMatchObject({ nudges: [], triggers: 0, final: 30 })
})

test('a subagent\'s step never triggers', ON, async ($, on) => {
  const w = world(on, FIRES)
  beneath(on, calls(120_000, 'Read'), calls(400_000, 'Read'))
  await start($)
  await step($, 0)
  await drain($.turn.step({ ...STEP, turnId: 'sub', index: 0, agentId: 'a1' }))
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(w.argvs).toEqual([])
  expect(await probe($)).toMatchObject({ nudges: [], triggers: 0 })
})

test('growth under 10 points triggers nothing', ON, async ($, on) => {
  const w = world(on, FIRES)
  beneath(on, calls(199_000, 'Read'))
  await start($)
  await step($, 0)
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(w.argvs).toEqual([])
})

test('with the context unmeasured nothing triggers', ON, async ($, on) => {
  const w = world(on, FIRES)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  beneath(on, calls(900_000, 'Read'))
  await step($, 0)
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(w.argvs).toEqual([])
})

test('a turn triggers at most twice: at 10 points, then at 20, then never again', ON, async ($, on) => {
  const w = world(on, FIRES)
  beneath(on, calls(350_000, 'Read'), calls(360_000, 'Read'), calls(900_000, 'Read'), calls(950_000, 'Read'))
  await start($)
  for (const index of [0, 1, 2, 3]) await step($, index)
  await w.clock.settle()
  // 25 points at the first step is one trigger there; the second waits for the next step.
  expect(w.records().map(r => [r.kind, r.kind === 'trigger' ? r.step : null, r.threshold])).toEqual([['trigger', 0, 10], ['trigger', 1, 20]])
  expect(w.logged).toEqual([attempt('user'), attempt('user')])
  expect(await probe($)).toMatchObject({ triggers: 2 })
})

test('the next turn starts its own count', ON, async ($, on) => {
  const w = world(on, FIRES)
  beneath(on, calls(220_000, 'Read'), answers(221_000), calls(340_000, 'Read'))
  await start($)
  await step($, 0)
  await step($, 1)
  await complete($, {})
  await drain($.turn.step({ ...STEP, turnId: 't2', index: 0 }))
  await w.clock.settle()
  expect(w.records().filter(r => r.kind === 'trigger').map(r => [r.turn, r.threshold, r.growth])).toEqual([['t1', 10, 12], ['t2', 10, 11.9]])
  expect(await probe($)).toMatchObject({ triggers: 1 })
})

test('when the turn completes, each trigger gets an outcome that says what the turn did afterwards', ON, async ($, on) => {
  const w = world(on, HOLDS)
  beneath(on, calls(220_000, 'Read'), calls(240_000, 'Agent', 'Read'), calls(245_000, 'Read'), answers(250_000))
  await start($)
  await step($, 0)
  await w.clock.advance(4000)
  for (const index of [1, 2, 3]) await step($, index)
  await w.clock.advance(500)
  await complete($, {})
  await w.clock.settle()
  expect(w.logged).toEqual([])
  expect(w.records()).toMatchObject([
    { kind: 'trigger', turn: 't1', threshold: 10, arm: 'hold' },
    { schema: 1, kind: 'outcome', rev: 1, ts: '2026-10-04T00:00:04.500Z', session: HOLDS, turn: 't1', threshold: 10, arm: 'hold', steps_after: 3, tools_after: 3, tool_names: { Agent: 1, Read: 2 }, growth_after: 3, ms_after: 4500, aborted: false },
  ])
})

test('an aborted turn\'s outcome says so, and a turn that never triggered gets none', ON, async ($, on) => {
  const w = world(on, HOLDS)
  beneath(on, calls(220_000, 'Read'), calls(150_000, 'Read'))
  await start($)
  await step($, 0)
  await complete($, { isAborted: true, reason: 'aborted' })
  await w.clock.settle()
  expect(w.records().map(r => [r.kind, r.kind === 'outcome' ? r.aborted : null])).toEqual([['trigger', null], ['outcome', true]])
  await drain($.turn.step({ ...STEP, turnId: 't2', index: 0 }))
  await complete($, { turnId: 't2' })
  await w.clock.settle()
  expect(w.records()).toHaveLength(2)
})

test('a subagent completing never closes the main turn\'s triggers', ON, async ($, on) => {
  const w = world(on, HOLDS)
  beneath(on, calls(220_000, 'Agent'))
  await start($)
  await step($, 0)
  await complete($, { turnId: 'sub', agentId: 'a1' })
  await w.clock.settle()
  expect(w.records().map(r => r.kind)).toEqual(['trigger'])
  await complete($, {})
  await w.clock.settle()
  expect(w.records().map(r => r.kind)).toEqual(['trigger', 'outcome'])
})

test('a steering log append that fails is reported to the debug log, and the step and the turn go on', ON, async ($, on) => {
  const w = world(on, HOLDS, { appendExit: 1 })
  beneath(on, calls(220_000, 'Read'))
  await start($)
  await step($, 0)
  expect(await complete($, { answer: 'Done.' })).toEqual({ text: 'Done.' })
  await w.clock.settle()
  expect(w.logged).toEqual([expect.stringContaining('log append exited 1'), expect.stringContaining('log append exited 1')])
})
