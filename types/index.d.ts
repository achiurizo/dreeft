export type ThinkingTail = { tail: string; live: boolean; phase: number }
/** `lastInput`: the input side of the last step's usage, to spot a measure of that same response. */
export type Ctx = { tokens: number; window: number; lastInput: number | null }
export type TurnMeta = {
  thinkMs: number
  blocks: number
  outTok: number
  startTokens: number | null
  window: number
  done: boolean
  final: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'whispered-thoughts': { line: ThinkingTail; ctx: Ctx | null; turn: TurnMeta | null; trail: number[] }
  }
}
