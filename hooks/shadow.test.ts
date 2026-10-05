import { describe, expect, test } from 'claude-code/testing'
import type { ToolCallInput, ToolCallResult, TurnCompleteInput } from 'claude-code'

import { createShadow } from './shadow'
import { STEP } from './testkit'

const DONE: TurnCompleteInput = { turnId: 't1', answer: 'The answer.', durationMs: 1, isAborted: false, reason: 'answer' }
const bash = (command: string): ToolCallInput => ({ tool: 'Bash', tool_use_id: 'u1', command })
const ran = (text: string): ToolCallResult => ({ result: { stdout: text, stderr: '', interrupted: false }, text })
const failed = (text: string): ToolCallResult => ({ result: { stdout: '', stderr: text, interrupted: false }, text, isError: true })

/** A shadow pass with turn `t1` open at step 0. */
function open() {
  const shadow = createShadow()
  shadow.step(STEP)
  return shadow
}

describe('createShadow', () => {
  test('a turn buffers its thinking, its answer text and its tool calls', () => {
    const shadow = open()
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'Reading ' })
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'the hook.' })
    shadow.tool(bash('cat hooks/shadow.ts'), ran('export function createShadow'))
    shadow.chunk('t1', { kind: 'text', index: 1, text: 'Done.' })
    expect(shadow.complete(DONE)).toEqual({
      turnId: 't1',
      thinking: 'Reading the hook.',
      text: 'Done.',
      tools: [{ name: 'Bash', terms: ['shadow.ts'], text: 'export function createShadow', isError: false }],
    })
  })

  test('thinking blocks are separated by a blank line, within a step and across steps', () => {
    const shadow = open()
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'one' })
    shadow.chunk('t1', { kind: 'tool', index: 1, id: 'u1', name: 'Bash' })
    shadow.chunk('t1', { kind: 'thinking', index: 2, text: 'two' })
    shadow.step({ ...STEP, index: 1 })
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'three' })
    expect(shadow.complete(DONE)?.thinking).toBe('one\n\ntwo\n\nthree')
  })

  test('with no text chunk, the answer comes from turn.complete', () => {
    const shadow = open()
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'x' })
    expect(shadow.complete(DONE)?.text).toBe('The answer.')
  })

  test('step 0 of a new turn drops the turn before it', () => {
    const shadow = open()
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'old' })
    shadow.step({ ...STEP, turnId: 't2' })
    shadow.chunk('t2', { kind: 'thinking', index: 0, text: 'new' })
    expect(shadow.complete({ ...DONE, turnId: 't2' })?.thinking).toBe('new')
  })

  test("another turn's chunks are ignored", () => {
    const shadow = open()
    shadow.chunk('t9', { kind: 'thinking', index: 0, text: 'elsewhere' })
    shadow.chunk('t9', { kind: 'text', index: 1, text: 'elsewhere' })
    expect(shadow.complete(DONE)).toMatchObject({ thinking: '', text: 'The answer.' })
  })

  test('an aborted turn, an unseen turn or a second completion gives nothing to judge', () => {
    expect(createShadow().complete(DONE)).toBeNull()
    expect(open().complete({ ...DONE, turnId: 't9' })).toBeNull()
    expect(open().complete({ ...DONE, isAborted: true, reason: 'aborted' })).toBeNull()
    const shadow = open()
    expect(shadow.complete(DONE)).not.toBeNull()
    expect(shadow.complete(DONE)).toBeNull()
  })

  test('a failed tool call is kept and marked; a denied one, or one before any turn, is not kept', () => {
    const early = createShadow()
    early.tool(bash('ls'), ran('out'))
    early.step(STEP)
    expect(early.complete(DONE)?.tools).toEqual([])

    const shadow = open()
    shadow.tool(bash('rm -rf /'), { deny: 'no' })
    shadow.tool(bash('cat missing.ts'), failed('No such file'))
    expect(shadow.complete(DONE)?.tools).toEqual([{ name: 'Bash', terms: ['missing.ts'], text: 'No such file', isError: true }])
  })

  test('caps: thinking stops growing at 200k chars, a result is cut to 2k, tools stop at 200', () => {
    const shadow = open()
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'a'.repeat(200_000) })
    shadow.chunk('t1', { kind: 'thinking', index: 0, text: 'more' })
    for (let i = 0; i < 205; i++) shadow.tool(bash('ls'), ran('r'.repeat(5_000)))
    const done = shadow.complete(DONE)
    expect(done?.thinking.length).toBe(200_000)
    expect(done?.tools).toHaveLength(200)
    expect(done?.tools[0]?.text.length).toBe(2_000)
  })

  test('a token the 2k cut would split is redacted whole, not kept as a fragment', () => {
    const shadow = open()
    shadow.tool(bash('env'), ran(`${'r'.repeat(1_984)} ghp_${'0'.repeat(30)} ${'r'.repeat(3_000)}`))
    expect(shadow.complete(DONE)?.tools[0]?.text).toBe(`${'r'.repeat(1_984)} [redacted]`)
  })

  test('a private key that opens before the cut and never ends is redacted to the end of the kept text', () => {
    const shadow = open()
    shadow.tool(bash('cat id'), ran(`${'r'.repeat(1_900)}\n-----BEGIN OPENSSH PRIVATE KEY-----\n${'0'.repeat(9_000)}`))
    expect(shadow.complete(DONE)?.tools[0]?.text).toBe(`${'r'.repeat(1_900)}\n[redacted]`)
  })

  test('a token the end of the redacted slice splits is dropped, however much the text before it shrank', () => {
    const shadow = open()
    const key = `-----BEGIN PRIVATE KEY-----\n${'0'.repeat(1_500)}\n-----END PRIVATE KEY-----`
    const rest = 'r'.repeat(3_013 - key.length)
    shadow.tool(bash('cat id'), ran(`${key}${rest} ghp_${'0'.repeat(6)}${'0'.repeat(40)}`))
    expect(shadow.complete(DONE)?.tools[0]?.text).toBe(`[redacted]${'r'.repeat(2_000 - key.length)}`)
  })
})
