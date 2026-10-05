import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnCompleteInput, TurnStepInput } from 'claude-code'

import type { Ctx, Phase, Trail, TurnMeta } from '../types'
import { addTerms, toolTerms } from './focus'
import { FOLDED, enterPhase, growthOf, inputTokens, newTurn, phaseOfMode, reduceChunk } from './turn'
import { bandRows, bandWidth } from './rows'
import type { Seg, Tone } from './rows'
import { createShadow } from './shadow'
import { appendLog, judgeTurn } from './shadow-io'
import type { LogIo, ShadowIo } from './shadow-io'
import { STEER_LOG, afterStep, coin, coinKey, nextThreshold, noticeText, nudgeText, outcomeRecord, steerArm, steerMode, triggerRecord } from './steer'
import type { OutcomeRecord, Pending, SteerMode, TriggerRecord } from './steer'

/** How often the ticker advances a running turn, in milliseconds. */
const TICK_MS = 1000
/** The session's context size, kept current by measures and each step's usage. */
const ctx = atom({ plugin: 'dreeft', key: 'ctx' } as const, null as Ctx | null)
/** The current main-loop turn, or the last one until the next starts. */
const turn = atom({ plugin: 'dreeft', key: 'turn' } as const, null as TurnMeta | null)
/** Recent main-loop turns' growth, in points of the window, oldest first; null marks a compaction. */
const trail = atom({ plugin: 'dreeft', key: 'trail' } as const, [] as Trail)
/** Turns of growth the trail keeps. */
const TRAIL_MAX = 20
/** Add one entry to the trail, a turn's growth or a compaction's null, dropping the oldest past `TRAIL_MAX`. */
const pushTrail = ($: EngineInterface, entry: number | null) => update($, trail, past => [...past, entry].slice(-TRAIL_MAX))

async function safely(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch {
    // The stream and the turn matter more than the band.
  }
}

/** `safely()` for synchronous work: what `fn` returned, or undefined when it threw. */
function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
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

/** A log append's engine calls as closures: `$` never crosses an import, so `appendLog` takes these. */
const logIo = ($: EngineInterface): LogIo => ({
  run: (argv, init) => $.process.run(argv, init),
  home: () => $.env.get('HOME'),
  stateHome: () => $.env.get('XDG_STATE_HOME'),
})

/** The shadow pass's engine calls as closures: `$` never crosses an import, so `judgeTurn` takes these. */
const shadowIo = ($: EngineInterface): ShadowIo => ({
  ...logIo($),
  cwd: () => $.session.cwd(),
  session: () => $.session.id(),
  now: () => $.clock.now(),
  complete: request => $.model.complete(request),
})

/** A line for the debug log; a log that throws costs nothing else. */
const debug = ($: EngineInterface, text: string) => void attempt(() => $.ui.log(text, { to: 'debug' }))

/** The running turn's steering triggers, each with what the turn did since. Memory only: a reload loses the outcomes still open. */
let pending: Pending[] = []

/** Appends records to the steering log, unawaited: a failure goes to the debug log, never to the turn. */
function logSteer($: EngineInterface, records: readonly (TriggerRecord | OutcomeRecord)[]) {
  const lines = records.map(r => `${JSON.stringify(r)}\n`).join('')
  void appendLog(logIo($), STEER_LOG, lines).catch(err => debug($, `steer log: ${String(err)}`))
}

/** Appends one text row to the main conversation; true when it was stored. A refusal or a throw goes to the debug log. */
async function appendRow($: EngineInterface, type: 'user' | 'system', text: string): Promise<boolean> {
  try {
    const row = await $.session.append({ message: { type, content: [{ type: 'text', text }] } })
    if (row.deny === undefined) return true
    debug($, `steer: the ${type} row was refused: ${row.deny}`)
  } catch (err) {
    debug($, `steer: the ${type} row was not appended: ${String(err)}`)
  }
  return false
}

/**
 * The end of a main-loop step whose tool calls are about to run, so the turn goes on: when growth has
 * crossed the turn's next threshold, flips the coin, sends the nudge on a fire, and logs either arm.
 * The appends are awaited: the row has to be stored before the turn's next request is built.
 */
async function nudge($: EngineInterface, e: TurnStepInput, mode: Exclude<SteerMode, 'off'>) {
  const t = await read($, turn)
  if (!t || t.done) return
  const growth = growthOf(t, await read($, ctx))
  // The larger count wins: memory covers a state write that failed, state covers a reload.
  const threshold = nextThreshold(growth, Math.max(t.triggers ?? 0, pending.length))
  if (growth === null || threshold === null) return
  const [session, now] = await Promise.all([$.session.id(), $.clock.now()])
  const arm = steerArm(mode, await coin(coinKey(session, e.turnId, threshold)))
  const trigger: Pending = { turn: e.turnId, step: e.index, threshold, growth, at: now, arm, steps: 0, tools: {} }
  // Counted before anything is sent: whatever fails below, this threshold is not tried again.
  pending = [...pending, trigger]
  // The model reads the user row; the system row is the person's notice of it, which the model never reads.
  const sent = arm === 'fire' && (await appendRow($, 'user', nudgeText(growth)))
  if (sent) await appendRow($, 'system', noticeText(growth))
  logSteer($, [triggerRecord({ ts: new Date(now).toISOString(), session, mode, sent }, trigger)])
  await update($, turn, x => x && { ...x, triggers: (x.triggers ?? 0) + 1, nudges: sent ? [...(x.nudges ?? []), now] : (x.nudges ?? []) })
}

/** Logs what the turn did after each of its triggers, once it has completed. */
async function closeSteer($: EngineInterface, e: TurnCompleteInput, open: readonly Pending[]) {
  const [session, now, t] = await Promise.all([$.session.id(), $.clock.now(), read($, turn)])
  const end = { ts: new Date(now).toISOString(), session, now, growth: t?.done ? t.final : null, aborted: e.isAborted }
  logSteer($, open.map(p => outcomeRecord(end, p)))
}

/** How a run of text is drawn. */
type Ink = { color?: string; dimColor?: boolean }
/** How the timeline's thinking and tool cells are drawn; writing is always plain, waiting blank. */
type Palette = { think: Ink; tool: Ink }
/** Timeline palettes, keyed by the `palette` setting; unknown values fall back to `mono`. */
const PALETTES = {
  mono: { think: {}, tool: { dimColor: true } },
  amber: { think: { color: 'yellow' }, tool: { dimColor: true } },
  blue: { think: { color: 'blue' }, tool: { dimColor: true } },
  magenta: { think: { color: 'magenta' }, tool: { color: 'cyan' } },
} satisfies Record<string, Palette>
const isPalette = (name: unknown): name is keyof typeof PALETTES => typeof name === 'string' && Object.hasOwn(PALETTES, name)

/** Registers the mod's hooks; `options.palette` picks the timeline palette, `options.memoryShadow` adds the shadow pass, `options.desktop` adds the desktop surface, `options.steer` adds the steering experiment. */
export const register: Register = (on, options) => {
  const palette: Palette = PALETTES[isPalette(options.palette) ? options.palette : 'mono']
  const ink: Record<Tone, Ink> = { faint: { color: 'gray', dimColor: true }, dim: { dimColor: true }, bright: {}, warn: { color: 'yellow' }, ...palette }
  const shadow = options.memoryShadow === 'on' ? createShadow() : null
  // Only the exact value opts in: the band's drawing on the desktop app is unchecked, so anything else is off.
  const onDesktop = options.desktop === 'on'
  // Off unless the exact value opts in: `on` changes what the model reads.
  const steer = steerMode(options.steer)
  /** What the shadow pass already judged this session. */
  const seen = new Set<string>()

  // Only the shadow pass reads tool results.
  if (shadow) {
    on('tool.call', async (_$, e, next) => {
      const result = await next(e)
      if (e.agentId === undefined) attempt(() => shadow.tool(e, result))
      return result
    })
  }

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
    if (e.agentId !== undefined) return next(e)
    stopTicker()
    spinnerPhase = null
    await safely(async () => {
      const t = await read($, turn)
      if (!t || t.done) return
      const now = await $.clock.now()
      const g = growthOf(t, await read($, ctx))
      if (g !== null) await pushTrail($, g)
      await update($, turn, x => x && { ...x, done: true, final: g, now })
    })
    const result = await next(e)
    const judged = attempt(() => shadow?.complete(e))
    // Unawaited, after the turn settled: the judge never delays or changes the turn.
    // The report goes through `safely()`: a log that throws or rejects would leave a rejection nothing handles.
    if (judged) void judgeTurn(shadowIo($), judged, seen).catch(err => safely(async () => $.ui.log(`memory shadow: ${String(err)}`, { to: 'debug' })))
    if (steer !== 'off' && pending.length > 0) {
      const open = pending.filter(p => p.turn === e.turnId)
      pending = []
      // Unawaited, after the turn settled, as the judge is.
      if (open.length > 0) void closeSteer($, e, open).catch(err => debug($, `steer log: ${String(err)}`))
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // A precompute installs nothing, and a skip leaves the conversation as it was.
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      await safely(() => pushTrail($, null))
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    attempt(() => shadow?.step(e))
    // A turn that never completed leaves its triggers behind: the next turn starts with none.
    if (steer !== 'off' && e.index === 0) pending = []

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
      if (step.done) {
        // The step's tool calls name what the turn touches, even when no thinking text streams.
        const terms = step.value.toolUses.flatMap(u => attempt(() => toolTerms(u.input)) ?? [])
        if (terms.length > 0) await safely(() => update($, turn, t => t && { ...t, focus: addTerms(t.focus, terms) }))
        // The stream is over and the calls are written: from here the tools run, until the next step waits.
        if (step.value.toolUses.length > 0) await safely(async () => {
          const now = await $.clock.now()
          await update($, turn, t => t && enterPhase(t, 'tool', now))
        })
        if (steer !== 'off') {
          // Before this step's own trigger: a trigger counts the steps after its own.
          attempt(() => {
            const names = step.value.toolUses.map(u => u.name)
            pending = pending.map(p => afterStep(p, names))
          })
          // Only where the turn goes on: a row appended on the final step would reach no request of this turn.
          if (step.value.toolUses.length > 0) await safely(() => nudge($, e, steer))
        }
        return step.value
      }
      const chunk = step.value
      attempt(() => shadow?.chunk(e.turnId, chunk))
      // A tool's streamed arguments change nothing in the turn: no clock read, no write, no redraw.
      if (FOLDED.has(chunk.kind)) await safely(async () => {
        const now = await $.clock.now()
        await update($, turn, t => t && reduceChunk(t, chunk, now))
        if (chunk.kind === 'stop' && chunk.usage) {
          const input = inputTokens(chunk.usage)
          const tokens = input + chunk.usage.output_tokens
          await update($, ctx, c => c && { ...c, tokens, lastInput: input })
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
    const width = bandWidth(e.props.bodyColumns)
    const drawsHere = e.surface === 'terminal' || (onDesktop && e.surface === 'desktop')
    if (!drawsHere || e.props.hasSurvey || !t || width === null) return next(e)
    const rows = bandRows(t, turns, c, width, e.props.maxRows)

    const { Box, Text } = $.ui.resolve(e)
    const seg = (part: Seg) => <Text {...ink[part.tone]}>{part.text}</Text>

    return (
      <Box flexDirection="column" alignItems="flex-end">
        {rows.map(row => (
          <Box>{row.map(seg)}</Box>
        ))}
      </Box>
    )
  })
}
