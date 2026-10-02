import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, RenderSurface, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { STEP, answerBelow, complete, measure } from './testkit'

const PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as RenderPropsOf['AbovePrompt']

/** Starts a main-loop step that has thought `text` and is still thinking; `then` ends it. */
async function thinking($: Engine, on: On, text: string, then: TurnStepChunk[] = [], before?: () => Promise<unknown>) {
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    yield { kind: 'thinking', index: 0, text }
    await held
    for (const chunk of then) yield chunk
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await before?.()
  const stream = $.turn.step(STEP)
  await stream.next()
  return {
    stream,
    async end() {
      release()
      for await (const _ of stream) {
        // read to the end
      }
    },
  }
}

/** The engine's own AbovePrompt: an empty band. */
function engineBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, null) as RenderElement
  })
}

/** Thought runs: everything but the meta row and the blank padding rows. */
async function thoughtRuns(view: Awaited<ReturnType<typeof mount>>) {
  return (await view.findAll({ type: 'Text' })).filter(r => !r.text.startsWith('◆') && r.text.trim() !== '')
}

const TEXT_THEN: TurnStepChunk[] = [{ kind: 'text', index: 1, text: 'ok' }]

function mount($: Engine, props: Partial<RenderPropsOf['AbovePrompt']> = {}, surface: RenderSurface = 'terminal') {
  return $.ui.mount({ plugin: 'whispered-thoughts', surface, component: 'AbovePrompt', props: { ...PROPS, ...props } })
}

test('draws the tail on the terminal while thinking', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing the band placement')
  const view = await mount($)
  expect(await view.find({ text: /weighing the band placement/ })).toBeDefined()
  await step.end()
})

test('live line shimmers: some run is not dim once the window enters', async ($, on) => {
  engineBand(on)
  const clock = mock.clock(on)
  const step = await thinking($, on, 'weighing the band placement')
  const view = await mount($)
  await clock.advance(80 * 6)
  const runs = (await view.findAll({ type: 'Text' })).filter(r => !r.text.startsWith('◆'))
  expect(runs.some(r => r.props.dimColor !== true)).toBe(true)
  expect(runs.some(r => r.props.dimColor === true)).toBe(true)
  await step.end()
})

test('frozen line is one dim run', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing', TEXT_THEN)
  const view = await mount($)
  await step.end()
  const runs = await thoughtRuns(view)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.props.dimColor).toBe(true)
  expect(runs[0]?.text).toBe('weighing')
})

test('draws nothing when not working', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing')
  const view = await mount($, { isWorking: false })
  expect(await view.find({ text: /weighing/ })).toBeUndefined()
  await step.end()
})

test('yields to a survey', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing')
  const view = await mount($, { hasSurvey: true })
  expect(await view.find({ text: /weighing/ })).toBeUndefined()
  await step.end()
})

test('draws nothing on a narrow band', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing')
  const view = await mount($, { bodyColumns: 19 })
  expect(await view.find({ text: /weighing/ })).toBeUndefined()
  await step.end()
})

test('draws nothing on the desktop surface', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing')
  const view = await mount($, {}, 'desktop')
  expect(await view.find({ text: /weighing/ })).toBeUndefined()
  await step.end()
})

test('three rows capped at 84 cells on a wide band, the first with an ellipsis', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'word '.repeat(80), TEXT_THEN)
  await step.end()
  const view = await mount($, { bodyColumns: 300 })
  const rows = (await thoughtRuns(view)).map(r => r.text)
  expect(rows).toHaveLength(3)
  expect(rows[0]?.startsWith('…')).toBe(true)
  for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(84)
  expect(rows.some(row => Array.from(row).length > 70)).toBe(true)
})

test('60% of the band on a mid-width terminal', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'word '.repeat(80), TEXT_THEN)
  await step.end()
  const view = await mount($, { bodyColumns: 80 })
  for (const run of await thoughtRuns(view)) expect(Array.from(run.text).length).toBeLessThanOrEqual(48)
})

test('the oldest row is faint, the middle dim, only the newest shimmers', async ($, on) => {
  engineBand(on)
  const clock = mock.clock(on)
  const step = await thinking($, on, 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda')
  const view = await mount($, { bodyColumns: 40 })
  await clock.advance(80 * 6)
  const runs = await thoughtRuns(view)
  expect(runs[0]?.props).toMatchObject({ color: 'gray', dimColor: true })
  expect(runs[1]?.props.dimColor).toBe(true)
  expect(runs[1]?.props.color).toBeUndefined()
  expect(runs.slice(2).some(r => r.props.dimColor !== true)).toBe(true)
  await step.end()
})

test('pads to three thought rows from the first words, so the band does not grow', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing')
  const view = await mount($)
  const blank = (await view.findAll({ type: 'Text' })).filter(r => r.text.trim() === '')
  expect(blank).toHaveLength(2)
  await step.end()
})

test('a short band keeps a row for the meta: maxRows 2 leaves one thought row', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'word '.repeat(80), TEXT_THEN)
  await step.end()
  const view = await mount($, { maxRows: 2 })
  expect(await thoughtRuns(view)).toHaveLength(1)
  expect((await view.findAll({ type: 'Text' })).filter(r => r.text.trim() === '')).toHaveLength(0)
})

test('row 2 shows metadata while working', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing')
  const view = await mount($)
  expect(await view.find({ text: /◆ \d+s · 1 blk/ })).toBeDefined()
  await step.end()
})

test('idle after a turn: row 2 only, with that turn\'s growth', async ($, on) => {
  engineBand(on)
  answerBelow(on)
  const step = await thinking($, on, 'weighing', [], () => measure($, 100_000, 1_000_000))
  await step.end()
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  const view = await mount($, { isWorking: false })
  expect(await view.find({ text: /weighing/ })).toBeUndefined()
  expect(await view.find({ text: /◆/ })).toBeDefined()
  expect(await view.find({ text: '+0.6%' })).toBeDefined()
})

test('idle meta row shows turns left from the trail', async ($, on) => {
  engineBand(on)
  answerBelow(on)
  const step = await thinking($, on, 'weighing', [], () => measure($, 100_000, 1_000_000))
  await step.end()
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  const view = await mount($, { isWorking: false, bodyColumns: 200 })
  // 89.4% left at 0.6 points a turn
  expect(await view.find({ text: '99+t left' })).toBeDefined()
})

test('nothing before any turn', async ($, on) => {
  engineBand(on)
  const view = await mount($, { isWorking: false })
  expect(await view.find({ text: /◆/ })).toBeUndefined()
})

test('idle with null growth shows metadata without a percent', async ($, on) => {
  engineBand(on)
  answerBelow(on)
  const step = await thinking($, on, 'weighing')
  await step.end()
  await complete($, {})
  const view = await mount($, { isWorking: false })
  const text = (await view.findAll({ type: 'Text' })).map(r => r.text).join('')
  expect(text).toContain('◆')
  expect(text).not.toContain('%')
})

test('narrow band hides row 2 too', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'weighing')
  const view = await mount($, { bodyColumns: 19 })
  expect(await view.find({ text: /◆/ })).toBeUndefined()
  await step.end()
})
