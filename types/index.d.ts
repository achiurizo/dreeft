/** The session's context size. */
export type Ctx = {
  /** Tokens in context, as of the last measure or step. */
  tokens: number
  /** The context window, in tokens. */
  window: number
  /** The input side of the last step's usage, to spot a measure of that same response. */
  lastInput: number | null
}

/** What the turn is doing: waiting on the model, thinking, in a tool call, or writing the answer. */
export type Phase = 'wait' | 'think' | 'tool' | 'write'
/** A phase change at clock time `at`; it lasts until the next one, or the turn's end. */
export type Span = { phase: Phase; at: number }
/** A name the thinking mentions, and how often; the most recently seen last. */
export type Term = { t: string; n: number }

/** One main-loop turn, from step 0 until the next turn starts. Times are clock milliseconds. */
export type TurnMeta = {
  /** Thinking blocks so far. */
  blocks: number
  /** Tool calls so far. */
  tools: number
  /** Output tokens across the turn's steps, thinking included. */
  outTok: number
  /** Context tokens at step 0, or null when nothing had been measured. */
  startTokens: number | null
  /** The context window at step 0, in tokens, or 0 when unknown. */
  window: number
  /** Set once the turn completes; the band keeps showing it until the next turn. */
  done: boolean
  /** The turn's growth in points of the window, fixed at completion; null while running or when unmeasured. */
  final: number | null
  /** Clock time of step 0. */
  started: number
  /** The latest clock time seen: a tick while the turn runs, else its last event. */
  now: number
  /** Phase changes in order; the first is `wait` at `started`. */
  spans: Span[]
  /** Names the thinking mentioned, with counts. */
  focus: Term[]
  /** Second-guesses: how often the thinking said "wait", "actually" or "hmm". */
  hedges: number
  /** Thinking text not yet scanned: a partial word or an open backtick. */
  carry: string
  /** The kind of the last chunk this step, to tell a new thinking block from more of one. */
  lastChunk: 'thinking' | 'text' | 'tool' | 'stop' | null
}

declare module 'claude-code' {
  interface PluginState {
    'whispered-thoughts': { ctx: Ctx | null; turn: TurnMeta | null; trail: number[] }
  }
}
