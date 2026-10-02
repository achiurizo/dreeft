import { atom, read, update } from 'claude-code'
import type { Register, Timer, TurnStepChunk } from 'claude-code'

import type { Ctx, ThinkingTail, TurnMeta } from '../types'
import { appendTail, metaRow, shimmerSegments, turnsLeft, wrapTail } from './lib'
import type { Seg } from './lib'

export const TICK_MS = 80
export const WINDOW = 4
export const MAX_WIDTH = 84
export const WIDTH_SHARE = 0.6
export const MIN_WIDTH = 12
export const THOUGHT_ROWS = 3
export const BUFFER = 1200

export const EMPTY: ThinkingTail = { tail: '', live: false, phase: 0 }
export const line = atom({ plugin: 'whispered-thoughts', key: 'line' } as const, EMPTY)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload drops the module's timer; never leave the line claiming to be live.
    await update($, line, s => ({ ...s, live: false }))
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
      await safely(async () => {
        const t = await read($, turn)
        if (!t || t.done) return
        const g = growthOf(t, await read($, ctx))
        if (g !== null) await update($, trail, past => [...past, g].slice(-TRAIL_MAX))
        await update($, turn, x => x && { ...x, done: true, final: g })
      })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    let clock: Timer | undefined
    let blockStart: number | undefined
    const freeze = async () => {
      if (blockStart !== undefined) {
        const started = blockStart
        blockStart = undefined
        await safely(async () => {
          const ms = (await $.clock.now()) - started
          await update($, turn, t => t && { ...t, thinkMs: t.thinkMs + ms })
        })
      }
      if (clock === undefined) return
      clock.cancel()
      clock = undefined
      await safely(() => update($, line, s => ({ ...s, live: false })))
    }
    // An abandoned dispatch need not close this generator, so `finally` alone can leak the timer.
    next.signal.addEventListener('abort', () => void freeze(), { once: true })
    const observe = async (chunk: TurnStepChunk) => {
      if (chunk.kind === 'thinking') {
        const fresh = clock === undefined
        await safely(() =>
          update($, line, s => ({
            tail: appendTail(fresh ? '' : s.tail, chunk.text, BUFFER),
            live: true,
            phase: fresh ? 0 : s.phase,
          })),
        )
        if (fresh) {
          await safely(() => update($, turn, t => t && { ...t, blocks: t.blocks + 1 }))
          await safely(async () => {
            blockStart = await $.clock.now()
          })
        }
        if (fresh && !next.signal.aborted) {
          clock = $.clock.every(TICK_MS, () => {
            void update($, line, s => ({ ...s, phase: s.phase + 1 })).catch(() => {})
          })
        }
      } else if (chunk.kind === 'text' || chunk.kind === 'tool') {
        await freeze()
      } else if (chunk.kind === 'stop' && chunk.usage) {
        const u = chunk.usage
        const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
        await safely(() => update($, turn, t => t && { ...t, outTok: t.outTok + u.output_tokens }))
        await safely(() => update($, ctx, c => c && { ...c, tokens: input + u.output_tokens, lastInput: input }))
      }
    }

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
        await update($, line, () => EMPTY)
        await update($, turn, () => ({
          thinkMs: 0,
          blocks: 0,
          outTok: 0,
          startTokens: c?.tokens ?? null,
          window: c?.window ?? 0,
          done: false,
          final: null,
        }))
      })
    }

    const stream = next(e)
    try {
      while (true) {
        const step = await stream.next()
        if (step.done) return step.value
        await observe(step.value)
        yield step.value
      }
    } finally {
      await freeze()
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Read every value first so a write to any of them redraws this band.
    const s = await read($, line)
    const t = await read($, turn)
    const turns = await read($, trail) // never `h`: that name is the JSX factory
    const c = await read($, ctx)
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)

    const width = Math.min(MAX_WIDTH, Math.floor(e.props.bodyColumns * WIDTH_SHARE))
    if (width < MIN_WIDTH) return next(e)

    const rows: Seg[][] = []
    if (e.props.isWorking && s.tail !== '') {
      // Always the full count, padded on top, so the band never grows as words arrive; one row stays for the meta.
      const count = Math.max(1, Math.min(THOUGHT_ROWS, e.props.maxRows - 1))
      const lines = wrapTail(s.tail, width, count)
      while (lines.length < count) lines.unshift('')
      lines.forEach((text, i) => {
        if (text === '') return rows.push([{ text: ' ', tone: 'dim' }])
        if (i === lines.length - 1 && s.live) {
          return rows.push(shimmerSegments(text, s.phase, WINDOW).map(run => ({ text: run.text, tone: run.dim ? 'dim' : 'bright' })))
        }
        rows.push([{ text, tone: i < lines.length - 2 ? 'faint' : 'dim' }])
      })
    }
    if (t) {
      const growth = t.done ? t.final : growthOf(t, c)
      // Once done, the turn's own growth is already the trail's last entry.
      const history = t.done && t.final !== null ? turns.slice(0, -1) : turns
      const left = c ? turnsLeft(c.tokens, c.window, turns) : null
      const meta = metaRow(t, growth, history, width, left)
      if (meta.length > 0) rows.push(meta)
    }
    if (rows.length === 0) return next(e)

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
