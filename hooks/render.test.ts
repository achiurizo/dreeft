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
  const step = await thinking($, on, 'weighing', [{ kind: 'text', index: 1, text: 'ok' }])
  const view = await mount($)
  await step.end()
  const runs = (await view.findAll({ type: 'Text' })).filter(r => !r.text.startsWith('◆'))
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
  const view = await mount($, { bodyColumns: 22 })
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

test('caps the line at 56 cells on a wide band', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'word '.repeat(60))
  const view = await mount($, { bodyColumns: 300 })
  const text = (await view.findAll({ type: 'Text' })).filter(r => !r.text.startsWith('◆')).map(r => r.text).join('')
  expect(text.startsWith('…')).toBe(true)
  expect(Array.from(text).length).toBeLessThanOrEqual(56)
  await step.end()
})

test('half the band on a mid-width terminal', async ($, on) => {
  engineBand(on)
  const step = await thinking($, on, 'word '.repeat(60))
  const view = await mount($, { bodyColumns: 80 })
  const text = (await view.findAll({ type: 'Text' })).filter(r => !r.text.startsWith('◆')).map(r => r.text).join('')
  expect(Array.from(text).length).toBeLessThanOrEqual(40)
  await step.end()
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
  const view = await mount($, { bodyColumns: 22 })
  expect(await view.find({ text: /◆/ })).toBeUndefined()
  await step.end()
})
