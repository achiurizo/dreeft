// Memory shadow mode (experimental): what a turn leaves behind for the shadow pass.
// Pure: no `$`, so every step is testable without the engine.

import type { ToolCallInput, ToolCallResult, TurnCompleteInput, TurnStepChunk, TurnStepInput } from 'claude-code'

import { toolTerms } from './focus'
import { redactHead } from './shadow-candidates'

/** What one main-loop turn left behind for the shadow pass. */
export type ShadowTurn = {
  turnId: string
  /** The turn's thinking text, blocks separated by a blank line. */
  thinking: string
  /** The turn's final answer text. */
  text: string
  /** The turn's tool calls with what they returned, in order. */
  tools: ToolEvidence[]
}

/** One tool call: the names its arguments touch and the result text the model read. */
export type ToolEvidence = { name: string; terms: string[]; text: string; isError: boolean }

/** Caps on what one turn buffers, so a runaway turn cannot grow the module without bound. */
const THINKING_MAX = 200_000
/** The evidence search wants one sentence of the answer that names a candidate: a dozen pages hold it. */
const TEXT_MAX = 50_000
const RESULT_MAX = 2_000
const TOOLS_MAX = 200

/**
 * The shadow pass: the mod's own `turn.step`, `tool.call` and `turn.complete` hooks feed it, since
 * a plugin holds one unmatched hook per event.
 */
export type Shadow = {
  /** A main-loop step starts; step 0 opens a fresh turn buffer. */
  step: (e: TurnStepInput) => void
  /** A main-loop chunk streamed past. */
  chunk: (turnId: string, chunk: TurnStepChunk) => void
  /** A main-loop tool call resolved. */
  tool: (e: ToolCallInput, result: ToolCallResult) => void
  /** A main-loop turn completed: the turn to judge, or null when it was aborted or never seen. */
  complete: (e: TurnCompleteInput) => ShadowTurn | null
}

/** A fresh shadow pass, holding the running turn's buffer. */
export function createShadow(): Shadow {
  let turn: ShadowTurn | null = null
  let lastKind: TurnStepChunk['kind'] | null = null
  return {
    step: e => {
      if (e.index === 0) turn = { turnId: e.turnId, thinking: '', text: '', tools: [] }
      lastKind = null
    },
    chunk: (turnId, chunk) => {
      if (turn && turn.turnId === turnId) {
        if (chunk.kind === 'thinking' && turn.thinking.length < THINKING_MAX) {
          const gap = lastKind !== 'thinking' && turn.thinking !== '' ? '\n\n' : ''
          turn.thinking += gap + chunk.text
        } else if (chunk.kind === 'text' && turn.text.length < TEXT_MAX) {
          turn.text += chunk.text
        }
      }
      lastKind = chunk.kind
    },
    tool: (e, result) => {
      if (!turn || turn.tools.length >= TOOLS_MAX || result.deny !== undefined) return
      turn.tools.push({ name: e.tool, terms: toolTerms(e), text: redactHead(result.text ?? '', RESULT_MAX), isError: result.isError === true })
    },
    complete: e => {
      const done = turn && turn.turnId === e.turnId ? turn : null
      turn = null
      if (!done || e.isAborted || e.reason === 'aborted') return null
      return { ...done, text: (done.text || e.answer).slice(0, TEXT_MAX) }
    },
  }
}
