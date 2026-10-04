import type { On, TurnCompleteInput, TurnStepChunk, TurnStepInput, TurnStepResult, TurnStepToolUse } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

import type { Ctx, Trail, TurnMeta } from '../types'

export const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }

/** Reads the mod's state for a test: the test `$` has no state noun. */
export const PROBE: Plugin = {
  name: 'probe',
  register: on => {
    on('command.run', async ($, e, next) => {
      if (e.command !== 'probe') return next(e)
      const read = async () => {
        switch (e.args) {
          case 'trail':
            return (await $.state.get({ plugin: 'dreeft', key: 'trail' } as const)).value
          case 'ctx':
            return (await $.state.get({ plugin: 'dreeft', key: 'ctx' } as const)).value
          default:
            return (await $.state.get({ plugin: 'dreeft', key: 'turn' } as const)).value
        }
      }
      return { text: JSON.stringify((await read()) ?? null) }
    })
  },
}

/** Test options that load the probe beside the mod. */
export const WITH_PROBE = { plugins: [PROBE] }

type Probed = { turn: TurnMeta | null; trail: Trail | null; ctx: Ctx | null }

export async function probe<K extends keyof Probed = 'turn'>($: Engine, key?: K): Promise<Probed[K]> {
  const { text } = await $.command.run({
    command: 'probe',
    args: key ?? 'turn',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  return JSON.parse(text ?? 'null')
}

/** A step's chunks, or its chunks and the tool calls its result reports. */
type Step = TurnStepChunk[] | { chunks: TurnStepChunk[]; toolUses: TurnStepToolUse[] }

/** Stands for the model beneath the mod: yields each step's chunks in turn. */
export function beneath(on: On, ...steps: Step[]) {
  const queue = [...steps]
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    const step = queue.shift() ?? []
    const { chunks, toolUses } = Array.isArray(step) ? { chunks: step, toolUses: [] } : step
    for (const chunk of chunks) yield chunk
    return { turnId: e.turnId, index: e.index, answer: '', toolUses, stopReason: 'end_turn', usage: null }
  })
}

/** A step's closing chunk with its usage: fresh input, output, and what the cache read and wrote. */
export function stop(stopReason: 'end_turn' | 'tool_use', input: number, output: number, cache = { read: 0, creation: 0 }): TurnStepChunk {
  const usage = { model: 'm', input_tokens: input, output_tokens: output, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.creation }
  return { kind: 'stop', stopReason, usage }
}

/** Engine-side answers for the events the mod observes and passes on. */
export function answerBelow(on: On) {
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
}

export function measure($: Engine, tokens: number, window: number) {
  return $.session.measure({ context: { tokens, window }, rateLimits: [], changed: ['context'] })
}

export function complete($: Engine, extra: Partial<TurnCompleteInput>) {
  return $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', ...extra } as TurnCompleteInput)
}

export async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    // read to the end
  }
}
