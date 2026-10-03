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
  return $.ui.mount({ plugin: 'dreeft', surface, component: 'AbovePrompt', props: { ...PROPS, ...props } })
}

async function runs(view: Awaited<ReturnType<typeof mount>>) {
  return view.findAll({ type: 'Text' })
}
const joined = async (view: Awaited<ReturnType<typeof mount>>) => (await runs(view)).map(r => r.text).join('')

test('nothing before any turn', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const view = await mount($, { isWorking: false })
  expect(await joined(view)).toBe('')
})

test('while thinking: focus row, timeline row, meta row', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'check `metaRow` then `metaRow` again, wait ')
  const view = await mount($)
  const text = await joined(view)
  expect(text).toContain('∴ metaRow ×2')
  expect(text).toContain('⟲ 1')
  expect(await view.find({ text: /◆ \d+s · 1 blk · 0 tools/ })).toBeDefined()
  await step.end()
})

test('mono by default: thinking cells plain, and the timeline grows with the clock', async ($, on) => {
  const clock = mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'weighing ')
  const view = await mount($)
  await clock.advance(4000)
  const think = (await runs(view)).find(r => r.text.startsWith('▀'))
  expect(think?.props.color).toBeUndefined()
  expect(think?.props.dimColor).not.toBe(true)
  expect(Array.from(think?.text ?? '').length).toBeGreaterThanOrEqual(4)
  expect(await joined(view)).toContain('think 4s')
  await step.end()
})

test('palette amber: thinking in yellow, tools dim', { options: { palette: 'amber' } }, async ($, on) => {
  const clock = mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'weighing ', [{ kind: 'tool', index: 1, id: 'x', name: 'Bash' }])
  await clock.advance(2000)
  await step.end()
  await clock.advance(2000)
  const all = await runs(await mount($))
  expect(all.find(r => r.text.startsWith('▀'))?.props.color).toBe('yellow')
  expect(all.find(r => r.text.startsWith('▄'))?.props.dimColor).toBe(true)
})

test('idle after a turn: the rows stay, with that turn\'s growth', async ($, on) => {
  const clock = mock.clock(on)
  engineBand(on)
  answerBelow(on)
  const step = await thinking($, on, 'uses `metaRow` and `metaRow` ', [], () => measure($, 100_000, 1_000_000))
  await clock.advance(2000)
  await step.end()
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  const view = await mount($, { isWorking: false })
  const text = await joined(view)
  expect(text).toContain('metaRow')
  expect(text).toContain('▀')
  expect(await view.find({ text: '+0.6%' })).toBeDefined()
})

test('no turns-left projection on the meta row', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  answerBelow(on)
  const step = await thinking($, on, 'x ', [], () => measure($, 100_000, 1_000_000))
  await step.end()
  await measure($, 106_000, 1_000_000)
  await complete($, {})
  expect(await joined(await mount($, { isWorking: false, bodyColumns: 200 }))).not.toContain('left')
})

test('every row fits 84 cells on a wide band', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, '`alphaOne` `betaTwo` `gammaThree` `deltaFour` '.repeat(3))
  const view = await mount($, { bodyColumns: 300 })
  const rows = (await view.findAll({ type: 'Box' })).slice(1)
  expect(rows.length).toBe(3)
  for (const row of rows) expect(Array.from(row.text).length).toBeLessThanOrEqual(84)
  await step.end()
})

test('a short band keeps the bottom rows: maxRows 1 is the meta row alone', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'uses `metaRow` ')
  const view = await mount($, { maxRows: 1 })
  const text = await joined(view)
  expect(text.startsWith('◆')).toBe(true)
  expect(text).not.toContain('∴')
  await step.end()
})

test('yields to a survey', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'weighing ')
  expect(await joined(await mount($, { hasSurvey: true }))).toBe('')
  await step.end()
})

test('draws nothing on a narrow band', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'weighing ')
  expect(await joined(await mount($, { bodyColumns: 19 }))).toBe('')
  await step.end()
})

test('draws nothing on the desktop surface', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'weighing ')
  expect(await joined(await mount($, {}, 'desktop'))).toBe('')
  await step.end()
})

test('the top row stays clear of the band\'s [-] corner', async ($, on) => {
  mock.clock(on)
  engineBand(on)
  const step = await thinking($, on, 'uses `metaRow` ')
  const view = await mount($)
  const top = (await view.findAll({ type: 'Box' }))[1]
  expect(top?.text.endsWith('    ')).toBe(true)
  expect(top?.text).toContain('∴')
  await step.end()
})
