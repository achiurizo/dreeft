import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Ctx, Phase, TurnMeta } from '../types'
import { addTerms, enterPhase, focusRow, metaRow, newTurn, phaseOfMode, phaseTotals, reduceChunk, timelineRow, toolTerms, topTerms } from './lib'
import type { Seg } from './lib'
import { JUDGE_SYSTEM, buildRecords, createShadow, failed, judgePrompt, parseVerdicts, selectCandidates } from './shadow'
import type { JudgeMeta, ShadowTurn } from './shadow'

/** How often the ticker advances a running turn, in milliseconds. */
const TICK_MS = 1000
/** The widest the band draws, in terminal cells. */
const MAX_WIDTH = 84
/** The share of the body's columns the band may take. */
const WIDTH_SHARE = 0.6
/** Under this many cells the band draws nothing. */
const MIN_WIDTH = 12
/** The most names the focus row shows. */
const FOCUS_TERMS = 3
/** Cells the engine's `[-]` collapse mark covers at the band's top-right corner, plus a gap. */
const CORNER = 4

/** The session's context size, kept current by measures and each step's usage. */
const ctx = atom({ plugin: 'whispered-thoughts', key: 'ctx' } as const, null as Ctx | null)
/** The current main-loop turn, or the last one until the next starts. */
const turn = atom({ plugin: 'whispered-thoughts', key: 'turn' } as const, null as TurnMeta | null)
/** Recent main-loop turns' growth, in points of the window, oldest first; null marks a compaction. */
const trail = atom({ plugin: 'whispered-thoughts', key: 'trail' } as const, [] as (number | null)[])
/** Turns of growth the trail keeps. */
const TRAIL_MAX = 20

/** Context growth since the turn's step 0, in percentage points of the window. */
function growthOf(t: TurnMeta | null, c: Ctx | null): number | null {
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

// Memory shadow mode (experimental): judge a turn's candidate facts and append them to a log.
// Never writes memory, never stages, never changes the turn.

/** The cheapest model the judge may use. */
const JUDGE_MODEL = 'claude-haiku-4-5-20251001'
/** The log, under `$HOME`. */
const LOG_DIR = '.local/state/whispered-thoughts'
const LOG_FILE = 'memory-shadow.jsonl'

/** The project's name and its main checkout, found once per load. */
let where: Promise<{ project: string; root: string }> | undefined

async function locate($: EngineInterface): Promise<{ project: string; root: string }> {
  const cwd = await $.session.cwd()
  const git = async (...args: string[]) => {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 }).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout.trim() : ''
  }
  const common = await git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const root = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : (await git('rev-parse', '--show-toplevel')) || cwd
  const remote = await git('remote', 'get-url', 'origin')
  // A remote may carry credentials; keep host and path only.
  const project = remote.replace(/^[a-z+]+:\/\/[^@/]*@/i, 'https://') || root.split('/').filter(Boolean).at(-1) || cwd
  return { project, root }
}

/** Appends lines to the log with `>>`, so concurrent sessions never drop each other's records. */
async function append($: EngineInterface, lines: string): Promise<void> {
  const home = await $.env.get('HOME')
  if (!home) return
  const dir = `${home}/${LOG_DIR}`
  await $.process.run(['/bin/sh', '-c', 'mkdir -p "$1" && cat >> "$1/$2"', 'sh', dir, LOG_FILE], { stdin: lines, timeoutMs: 5000 })
}

/** Judge one finished turn and log every candidate; nothing at all when it has none. */
async function judgeTurn($: EngineInterface, done: ShadowTurn): Promise<void> {
  const candidates = selectCandidates(done)
  if (candidates.length === 0) return
  where ??= locate($)
  const [{ project, root }, session, now] = await Promise.all([where, $.session.id(), $.clock.now()])
  const reply = await $.model.complete({
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(project, candidates),
    maxTokens: 200 * candidates.length + 100,
    timeoutMs: 30_000,
  })
  const judge: JudgeMeta = {
    model: JUDGE_MODEL,
    candidates: candidates.length,
    input_tokens: reply.usage.input_tokens + reply.usage.cache_read_input_tokens + reply.usage.cache_creation_input_tokens,
    output_tokens: reply.usage.output_tokens,
  }
  const verdicts = reply.isAnswered
    ? parseVerdicts(reply.text, candidates.length)
    : candidates.map(() => failed(`judge call failed: ${reply.reason}`))
  const records = buildRecords({ ts: new Date(now).toISOString(), session, turn: done.turnId, project, root }, candidates, verdicts, judge)
  await append($, records.map(r => `${JSON.stringify(r)}\n`).join(''))
}

/** How the timeline's thinking and tool cells are drawn; writing is always plain, waiting blank. */
type Ink = { color?: string; dimColor?: boolean }
/** Timeline palettes, keyed by the `palette` setting; unknown values fall back to `mono`. */
const PALETTES = {
  mono: { think: {}, tool: { dimColor: true } },
  amber: { think: { color: 'yellow' }, tool: { dimColor: true } },
  blue: { think: { color: 'blue' }, tool: { dimColor: true } },
  magenta: { think: { color: 'magenta' }, tool: { color: 'cyan' } },
} satisfies Record<string, { think: Ink; tool: Ink }>
const isPalette = (name: unknown): name is keyof typeof PALETTES => typeof name === 'string' && Object.hasOwn(PALETTES, name)

/** Registers the mod's hooks; `options.palette` picks the timeline palette, `options.memoryShadow` adds the shadow pass. */
export const register: Register = (on, options) => {
  const palette: { think: Ink; tool: Ink } = PALETTES[isPalette(options.palette) ? options.palette : 'mono']
  const shadow = options.memoryShadow === 'on' ? createShadow() : null

  // Only the shadow pass reads tool results.
  if (shadow) {
    on('tool.call', async (_$, e, next) => {
      const result = await next(e)
      if (e.agentId === undefined) shadow.tool(e, result)
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
      if (g !== null) await update($, trail, past => [...past, g].slice(-TRAIL_MAX))
      await update($, turn, x => x && { ...x, done: true, final: g, now })
    })
    const result = await next(e)
    const judged = shadow?.complete(e)
    // Unawaited, after the turn settled: the judge never delays or changes the turn.
    if (judged) void judgeTurn($, judged).catch(err => $.ui.log(`memory shadow: ${String(err)}`, { to: 'debug' }))
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // A precompute installs nothing, and a skip leaves the conversation as it was.
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      await safely(() => update($, trail, past => [...past, null].slice(-TRAIL_MAX)))
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    shadow?.step(e)

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
        const terms = step.value.toolUses.flatMap(u => toolTerms(u.input))
        if (terms.length > 0) await safely(() => update($, turn, t => t && { ...t, focus: addTerms(t.focus, terms) }))
        return step.value
      }
      const chunk = step.value
      shadow?.chunk(e.turnId, chunk)
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
      metaRow({ thinkMs: totals.think, blocks: t.blocks, tools: t.tools }, growth, history, max)
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
        <Text {...palette.think}>{part.text}</Text>
      ) : part.tone === 'tool' ? (
        <Text {...palette.tool}>{part.text}</Text>
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
