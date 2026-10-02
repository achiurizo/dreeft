import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Ctx, Phase, TurnMeta } from '../types'
import { enterPhase, focusRow, metaRow, newTurn, phaseOfMode, phaseTotals, reduceChunk, timelineRow, topTerms } from './lib'
import type { Seg } from './lib'

/** How often the ticker advances a running turn, in milliseconds. */
export const TICK_MS = 1000
/** The widest the band draws, in terminal cells. */
export const MAX_WIDTH = 84
/** The share of the body's columns the band may take. */
export const WIDTH_SHARE = 0.6
/** Under this many cells the band draws nothing. */
export const MIN_WIDTH = 12
/** The most names the focus row shows. */
export const FOCUS_TERMS = 3
/** Cells the engine's `[-]` collapse mark covers at the band's top-right corner, plus a gap. */
export const CORNER = 4

/** The session's context size, kept current by measures and each step's usage. */
export const ctx = atom({ plugin: 'whispered-thoughts', key: 'ctx' } as const, null as Ctx | null)
/** The current main-loop turn, or the last one until the next starts. */
export const turn = atom({ plugin: 'whispered-thoughts', key: 'turn' } as const, null as TurnMeta | null)
/** Recent main-loop turns' growth, in points of the window, oldest first. */
export const trail = atom({ plugin: 'whispered-thoughts', key: 'trail' } as const, [] as number[])
/** Turns of growth the trail keeps. */
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
/** The phase the spinner last drew, applied on the next tick; null until it draws this turn. */
let spinnerPhase: Phase | null = null
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
      await update($, turn, x => x && !x.done ? { ...(spinnerPhase ? enterPhase(x, spinnerPhase, now) : x), now } : x)
    })().catch(() => {})
  })
}

/** How the timeline's thinking and tool cells are drawn; writing is always plain, waiting blank. */
type Ink = { color?: string; dimColor?: boolean }
/** Timeline palettes, keyed by the `palette` setting; unknown values fall back to `mono`. */
export const PALETTES: Record<string, { think: Ink; tool: Ink }> = {
  mono: { think: {}, tool: { dimColor: true } },
  amber: { think: { color: 'yellow' }, tool: { dimColor: true } },
  blue: { think: { color: 'blue' }, tool: { dimColor: true } },
  magenta: { think: { color: 'magenta' }, tool: { color: 'cyan' } },
}

/** Registers the mod's hooks; `options.palette` picks the timeline palette. */
export const register: Register = (on, options) => {
  const palette = PALETTES[String(options.palette)] ?? PALETTES.mono

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
      spinnerPhase = null
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
        spinnerPhase = null
        startTicker($)
      })
    } else {
      // Between steps a tool ran; this step starts by waiting on the model again.
      await safely(async () => {
        const now = await $.clock.now()
        await update($, turn, t => t && { ...enterPhase(t, 'wait', now), lastChunk: null })
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

  // The spinner knows what the turn is doing even when no chunk says so (thinking with summaries off).
  // Drawing is pure, so it only notes the mode; the next tick folds it into the turn.
  on('ui.render', { component: 'Spinner' }, async (_$, e, next) => {
    spinnerPhase = phaseOfMode(e.props.mode)
    return next(e)
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
    const metaFor = (max: number) =>
      metaRow({ thinkMs: totals.think, blocks: t.blocks, tools: t.tools, outTok: t.outTok }, growth, history, max)
    const builders = [
      (max: number) => focusRow(topTerms(t.focus, FOCUS_TERMS), t.hedges, max),
      (max: number) => timelineRow(t.spans, t.started, t.now, max),
      metaFor,
    ].slice(-Math.max(1, e.props.maxRows)) // a short band keeps the bottom rows
    // The top row stops short of the corner the engine's [-] mark covers.
    const rows: Seg[][] = builders
      .map((build, i) => (i === 0 ? [...build(width - CORNER), { text: ' '.repeat(CORNER), tone: 'dim' as const }] : build(width)))
      .filter(row => row.some(seg => seg.text.trim() !== ''))

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
        <Text {...palette?.think}>{part.text}</Text>
      ) : part.tone === 'tool' ? (
        <Text {...palette?.tool}>{part.text}</Text>
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
