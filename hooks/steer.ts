// Steering (experimental): when a turn's context growth crosses a threshold, a coin flip decides whether
// the model is told. Pure: the trigger, the arm, the text and the log records. No engine access.

/** Bumped by hand when the trigger, the thresholds or the text change, so log lines from before and after can be told apart. */
export const STEER_REV = 1
/** Growth, in points of the window, at which a turn triggers: once per entry, in order, so at most twice. */
export const THRESHOLDS: readonly number[] = [10, 20]
/** The steering log's file name, beside the memory shadow log. */
export const STEER_LOG = 'steer.jsonl'

/** The `steer` setting: `off` does nothing, `shadow` logs triggers, `on` also sends half of them to the model. */
export type SteerMode = 'off' | 'shadow' | 'on'
/** What a trigger does: `fire` appends the nudge and logs, `hold` only logs. */
export type Arm = 'fire' | 'hold'

/** The `steer` setting as read: only the exact values opt in, anything else is `off`. */
export function steerMode(value: unknown): SteerMode {
  return value === 'shadow' || value === 'on' ? value : 'off'
}

/**
 * The threshold a step boundary triggers, or null when it triggers nothing.
 * @param growth - the turn's context growth so far, in points of the window, or null when unmeasured
 * @param triggered - how many triggers the turn already had
 */
export function nextThreshold(growth: number | null, triggered: number): number | null {
  // `at()` would read a negative count from the end: only a whole count from 0 up names an entry.
  const threshold = Number.isInteger(triggered) && triggered >= 0 ? THRESHOLDS[triggered] : undefined
  return growth !== null && threshold !== undefined && growth >= threshold ? threshold : null
}

/**
 * Which arm a trigger takes: `shadow` always holds, `on` fires for half of the random numbers.
 * @param random - a number in [0, 1): `coin()` of the trigger's key
 */
export function steerArm(mode: Exclude<SteerMode, 'off'>, random: number): Arm {
  return mode === 'on' && random < 0.5 ? 'fire' : 'hold'
}

/** What a trigger's coin is flipped on: each trigger of each turn of each session gets its own flip. */
export function coinKey(session: string, turn: string, threshold: number): string {
  return `${session}|${turn}|${threshold}`
}

/**
 * The coin: a number in [0, 1) from a hash of `key`, spread evenly over keys. The hooks sandbox freezes
 * `Math`, so a test cannot replace `Math.random`; a hash of ids the log also records can be replayed.
 */
export async function coin(key: string): Promise<number> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  // The first four bytes as one unsigned number, over its range.
  return hash.slice(0, 4).reduce((n, byte) => n * 256 + byte, 0) / 2 ** 32
}

/** The row the model reads on a fired trigger; `growth` in points of the window. */
export function nudgeText(growth: number): string {
  return `[dreeft] This turn has grown the context by ${Math.round(growth)} points of the window. If large reads remain, hand them to a subagent and keep only the conclusion.`
}

/** The transcript notice the person sees beside a fired nudge; the model never reads it. */
export function noticeText(growth: number): string {
  return `dreeft steer: sent the model a hidden note at ${Math.round(growth)} points of context growth, suggesting a subagent for large reads.`
}

/** One trigger of a running turn, and what the turn has done since. Times are clock milliseconds. */
export type Pending = {
  /** The turn's id. */
  turn: string
  /** The index of the step whose end triggered. */
  step: number
  /** The threshold crossed, in points of the window. */
  threshold: number
  /** The turn's growth at the trigger, in points of the window. */
  growth: number
  /** Clock time of the trigger. */
  at: number
  arm: Arm
  /** Steps that ended after the trigger's own. */
  steps: number
  /** Tool calls those steps made, counted per tool name. */
  tools: Record<string, number>
}

/**
 * The trigger after one more step of its turn ended.
 * @param names - the name of each tool call the step made
 */
export function afterStep(p: Pending, names: readonly string[]): Pending {
  // A map, not an object: a tool named `constructor` or `__proto__` is a name like any other.
  const tools = new Map(Object.entries(p.tools))
  for (const name of names) tools.set(name, (tools.get(name) ?? 0) + 1)
  return { ...p, steps: p.steps + 1, tools: Object.fromEntries(tools) }
}

/** One line of the steering log, written when a trigger is given its arm. */
export type TriggerRecord = {
  schema: 1
  kind: 'trigger'
  /** `STEER_REV` of the code that wrote the line. */
  rev: number
  ts: string
  session: string
  turn: string
  step: number
  threshold: number
  growth: number
  mode: Exclude<SteerMode, 'off'>
  arm: Arm
  /** True when the nudge was stored in the conversation: false for a hold, and for a fire the engine refused. */
  sent: boolean
  /** The nudge's text for a fire, null for a hold. */
  text: string | null
}

/** One line of the steering log, written per trigger when its turn completes. `turn` and `threshold` join it to its trigger. */
export type OutcomeRecord = {
  schema: 1
  kind: 'outcome'
  rev: number
  ts: string
  session: string
  turn: string
  threshold: number
  arm: Arm
  /** Steps that ended after the trigger's own. */
  steps_after: number
  /** Tool calls those steps made. */
  tools_after: number
  /** The same calls per tool name: a subagent call is what the nudge suggests. */
  tool_names: Record<string, number>
  /** Points of the window the turn grew after the trigger, or null when its end was unmeasured. */
  growth_after: number | null
  /** Milliseconds from the trigger to the turn's end. */
  ms_after: number
  aborted: boolean
}

/** The trigger line for `p`; `sent` says whether the nudge was stored. */
export function triggerRecord(meta: { ts: string; session: string; mode: Exclude<SteerMode, 'off'>; sent: boolean }, p: Pending): TriggerRecord {
  return {
    schema: 1, kind: 'trigger', rev: STEER_REV, ts: meta.ts, session: meta.session, turn: p.turn, step: p.step,
    threshold: p.threshold, growth: p.growth, mode: meta.mode, arm: p.arm, sent: meta.sent, text: p.arm === 'fire' ? nudgeText(p.growth) : null,
  }
}

/**
 * The outcome line for `p`, at its turn's end.
 * @param end - `now` is the clock time of the end, `growth` the turn's final growth in points or null when unmeasured
 */
export function outcomeRecord(end: { ts: string; session: string; now: number; growth: number | null; aborted: boolean }, p: Pending): OutcomeRecord {
  return {
    schema: 1, kind: 'outcome', rev: STEER_REV, ts: end.ts, session: end.session, turn: p.turn, threshold: p.threshold, arm: p.arm,
    steps_after: p.steps,
    tools_after: Object.values(p.tools).reduce((sum, n) => sum + n, 0),
    tool_names: p.tools,
    // Two decimals, as growth itself is kept: a float difference would log 2.4999999999999996.
    growth_after: end.growth === null ? null : Math.round((end.growth - p.growth) * 100) / 100,
    ms_after: Math.max(0, end.now - p.at),
    aborted: end.aborted,
  }
}
