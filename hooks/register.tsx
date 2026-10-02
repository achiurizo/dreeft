import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Ctx, TurnMeta } from '../types'
import { enterPhase, focusRow, metaRow, newTurn, phaseTotals, reduceChunk, timelineRow, topTerms } from './lib'
import type { Seg } from './lib'

export const TICK_MS = 1000
export const MAX_WIDTH = 84
export const WIDTH_SHARE = 0.6
export const MIN_WIDTH = 12
export const FOCUS_TERMS = 3

export const ctx = atom({ plugin: 'whispered-thoughts', key: 'ctx' } as const, null as Ctx | null)
export const turn = atom({ plugin: 'whispered-thoughts', key: 'turn' } as const, null as TurnMeta | null)
export const trail = atom({ plugin: 'whispered-thoughts', key: 'trail' } as const, [] as number[])
export const TRAIL_MAX = 20

/** Context growth since the turn's step 0, in percentage points of the window. */
export function growthOf(t: TurnMeta | null, c: Ctx | null): number | null {
  if (!t || !c || t.startTokens === null || t.window <= 0) return null
  return Math.round(((c.tokens - t.startTokens) / t.window) * 10000) / 100
}

async function safely(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch {
    // The stream and the turn matter more than the band.
  }
}

// One ticker while a main-loop turn runs, so the timeline grows between steps too (tools run there).
let ticker: Timer | undefined
function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}
function startTicker($: EngineInterface) {
  stopTicker()
  ticker = $.clock.every(TICK_MS, () => {
    void (async () => {
      const now = await $.clock.now()
      const t = await read($, turn)
      if (!t || t.done) return stopTicker()
      await update($, turn, x => x && { ...x, now })
    })().catch(() => {})
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload drops the module's ticker; pick it back up if a turn is still running.
    await safely(async () => {
      const t = await read($, turn)
      if (t && !t.done) startTicker($)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const { tokens, window } = e.context
    if (tokens !== undefined && window > 0) {
      // A measure of the response the last step already counted (output included) would undercount it.
      await safely(() =>
        update($, ctx, c => (c && c.lastInput === tokens ? { ...c, window } : { tokens, window, lastInput: null })),
      )
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      stopTicker()
      await safely(async () => {
        const t = await read($, turn)
        if (!t || t.done) return
        const now = await $.clock.now()
        const g = growthOf(t, await read($, ctx))
        if (g !== null) await update($, trail, past => [...past, g].slice(-TRAIL_MAX))
        await update($, turn, x => x && { ...x, done: true, final: g, now })
      })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    if (e.index === 0) {
      // Nothing measured since load: seed from the status line's figures, apart so a failure here
      // cannot cost the turn reset below.
      await safely(async () => {
        if (await read($, ctx)) return
        const { context } = await $.session.usage()
        if (context.tokens !== undefined && context.window > 0) {
          const seeded = { tokens: context.tokens, window: context.window, lastInput: null }
          await update($, ctx, () => seeded)
        }
      })
      await safely(async () => {
        const c = await read($, ctx)
        const now = await $.clock.now()
        await update($, turn, () => newTurn(now, c?.tokens ?? null, c?.window ?? 0))
        startTicker($)
      })
    } else {
      // Between steps a tool ran; this step starts by waiting on the model again.
      await safely(async () => {
        const now = await $.clock.now()
        await update($, turn, t => t && enterPhase(t, 'wait', now))
      })
    }

    const stream = next(e)
    while (true) {
      const step = await stream.next()
      if (step.done) return step.value
      const chunk = step.value
      await safely(async () => {
        const now = await $.clock.now()
        await update($, turn, t => t && reduceChunk(t, chunk, now))
        if (chunk.kind === 'stop' && chunk.usage) {
          const u = chunk.usage
          const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
          await update($, ctx, c => c && { ...c, tokens: input + u.output_tokens, lastInput: input })
        }
      })
      yield chunk
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Read every value first so a write to any of them redraws this band.
    const t = await read($, turn)
    const turns = await read($, trail) // never `h`: that name is the JSX factory
    const c = await read($, ctx)
    if (e.surface !== 'terminal' || e.props.hasSurvey || !t) return next(e)

    const width = Math.min(MAX_WIDTH, Math.floor(e.props.bodyColumns * WIDTH_SHARE))
    if (width < MIN_WIDTH) return next(e)

    const totals = phaseTotals(t.spans, t.now)
    const growth = t.done ? t.final : growthOf(t, c)
    // Once done, the turn's own growth is already the trail's last entry.
    const history = t.done && t.final !== null ? turns.slice(0, -1) : turns
    const meta = metaRow({ thinkMs: totals.think, blocks: t.blocks, tools: t.tools, outTok: t.outTok }, growth, history, width)
    const rows: Seg[][] = [
      focusRow(topTerms(t.focus, FOCUS_TERMS), t.hedges, width),
      timelineRow(t.spans, t.started, t.now, width),
      ...(meta.length > 0 ? [meta] : []),
    ].slice(-Math.max(1, e.props.maxRows)) // a short band keeps the bottom rows

    const { Box, Text } = $.ui.resolve(e)
    const seg = (part: Seg) =>
      part.tone === 'faint' ? (
        <Text color="gray" dimColor>
          {part.text}
        </Text>
      ) : part.tone === 'dim' ? (
        <Text dimColor>{part.text}</Text>
      ) : part.tone === 'warn' ? (
        <Text color="yellow">{part.text}</Text>
      ) : part.tone === 'think' ? (
        <Text color="magenta">{part.text}</Text>
      ) : part.tone === 'tool' ? (
        <Text color="cyan">{part.text}</Text>
      ) : (
        <Text>{part.text}</Text>
      )

    return (
      <Box flexDirection="column" alignItems="flex-end">
        {rows.map(row => (
          <Box>{row.map(seg)}</Box>
        ))}
      </Box>
    )
  })
}
