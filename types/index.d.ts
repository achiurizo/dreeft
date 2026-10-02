/** `lastInput`: the input side of the last step's usage, to spot a measure of that same response. */
export type Ctx = { tokens: number; window: number; lastInput: number | null }

/** What the turn is doing: waiting on the model, thinking, in a tool call, or writing the answer. */
export type Phase = 'wait' | 'think' | 'tool' | 'write'
/** A phase change at clock time `at`; it lasts until the next one, or the turn's end. */
export type Span = { phase: Phase; at: number }
/** A name the thinking mentions, and how often; the most recently seen last. */
export type Term = { t: string; n: number }

export type TurnMeta = {
  blocks: number
  tools: number
  outTok: number
  startTokens: number | null
  window: number
  done: boolean
  final: number | null
  started: number
  /** The latest clock time seen: a tick while the turn runs, else its last event. */
  now: number
  spans: Span[]
  focus: Term[]
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
