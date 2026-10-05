import { describe, expect, test } from 'claude-code/testing'

import { STEER_LOG, STEER_REV, THRESHOLDS, afterStep, coin, coinKey, nextThreshold, noticeText, nudgeText, outcomeRecord, steerArm, steerMode, triggerRecord } from './steer'
import type { Pending } from './steer'

const PENDING: Pending = { turn: 't1', step: 2, threshold: 10, growth: 12.4, at: 5000, arm: 'fire', steps: 0, tools: {} }

describe('steer', () => {
  test('steerMode: shadow and on opt in, anything else is off', () => {
    expect(steerMode('shadow')).toBe('shadow')
    expect(steerMode('on')).toBe('on')
    expect(steerMode('off')).toBe('off')
    expect(steerMode(undefined)).toBe('off')
    expect(steerMode('ON')).toBe('off')
    expect(steerMode(true)).toBe('off')
  })

  test('nextThreshold: the first trigger is at 10 points or more, not under', () => {
    expect(THRESHOLDS).toEqual([10, 20])
    expect(nextThreshold(9.99, 0)).toBeNull()
    expect(nextThreshold(10, 0)).toBe(10)
    expect(nextThreshold(12.4, 0)).toBe(10)
  })

  test('nextThreshold: the second trigger waits for 20 points or more', () => {
    expect(nextThreshold(19.99, 1)).toBeNull()
    expect(nextThreshold(20, 1)).toBe(20)
  })

  test('nextThreshold: a turn that jumps from 5 to 25 triggers once at that step, and again at a later one', () => {
    expect(nextThreshold(5, 0)).toBeNull()
    expect(nextThreshold(25, 0)).toBe(10)
    expect(nextThreshold(25, 1)).toBe(20)
  })

  test('nextThreshold: a turn never triggers a third time', () => {
    expect(nextThreshold(90, 2)).toBeNull()
    expect(nextThreshold(90, 7)).toBeNull()
  })

  test('nextThreshold: unmeasured growth never triggers', () => {
    expect(nextThreshold(null, 0)).toBeNull()
    expect(nextThreshold(null, 1)).toBeNull()
  })

  test('nextThreshold: a count that is not a whole number from 0 up never triggers', () => {
    expect(nextThreshold(50, -1)).toBeNull()
    expect(nextThreshold(50, 0.5)).toBeNull()
    expect(nextThreshold(50, Number.NaN)).toBeNull()
  })

  test('steerArm: on fires for the lower half of the random numbers and holds for the upper half', () => {
    expect(steerArm('on', 0)).toBe('fire')
    expect(steerArm('on', 0.4999)).toBe('fire')
    expect(steerArm('on', 0.5)).toBe('hold')
    expect(steerArm('on', 0.9999)).toBe('hold')
  })

  test('steerArm: shadow always holds', () => {
    expect(steerArm('shadow', 0)).toBe('hold')
    expect(steerArm('shadow', 0.9999)).toBe('hold')
  })

  test('coin: a key always gets the same number in [0, 1), and keys spread over both halves', async () => {
    expect((await coin('s7|t1|10')).toFixed(4)).toBe('0.2761')
    expect((await coin('s7|t1|20')).toFixed(4)).toBe('0.0416')
    expect((await coin('s1|t1|10')).toFixed(4)).toBe('0.6683')
    expect((await coin('s1|t1|20')).toFixed(4)).toBe('0.9342')
    expect(await coin('s7|t1|10')).toBe(await coin('s7|t1|10'))
    const many = await Promise.all(Array.from({ length: 400 }, (_, i) => coin(`session-${i}|t1|10`)))
    expect(many.every(n => n >= 0 && n < 1)).toBe(true)
    const fired = many.filter(n => steerArm('on', n) === 'fire').length
    expect(fired).toBeGreaterThan(160)
    expect(fired).toBeLessThan(240)
  })

  test('coinKey: the session, the turn and the threshold, so each trigger gets its own flip', () => {
    expect(coinKey('s7', 't1', 10)).toBe('s7|t1|10')
  })

  test('nudgeText: one suggestion, the growth as whole points, marked as the mod\'s, ASCII only', () => {
    expect(nudgeText(12.4)).toBe('[dreeft] This turn has grown the context by 12 points of the window. If large reads remain, hand them to a subagent and keep only the conclusion.')
    expect(nudgeText(25.5)).toContain('by 26 points')
    expect(/^[\x20-\x7e]+$/.test(nudgeText(12.4))).toBe(true)
  })

  test('noticeText: tells the person what the model was sent, ASCII only', () => {
    expect(noticeText(12.4)).toBe('dreeft steer: sent the model a hidden note at 12 points of context growth, suggesting a subagent for large reads.')
    expect(/^[\x20-\x7e]+$/.test(noticeText(12.4))).toBe(true)
  })

  test('triggerRecord: a fired trigger carries the text it sent', () => {
    const text = nudgeText(12.4)
    expect(triggerRecord({ ts: '2026-10-04T00:00:00.000Z', session: 's1', mode: 'on', sent: true }, PENDING)).toEqual({
      schema: 1, kind: 'trigger', rev: STEER_REV, ts: '2026-10-04T00:00:00.000Z', session: 's1', turn: 't1', step: 2,
      threshold: 10, growth: 12.4, mode: 'on', arm: 'fire', sent: true, text,
    })
  })

  test('triggerRecord: a held trigger carries no text and was not sent', () => {
    const held = triggerRecord({ ts: 'ts', session: 's1', mode: 'shadow', sent: false }, { ...PENDING, arm: 'hold' })
    expect(held).toMatchObject({ kind: 'trigger', mode: 'shadow', arm: 'hold', sent: false, text: null })
  })

  test('triggerRecord: a fired trigger whose append was refused keeps its text and says it was not sent', () => {
    const refused = triggerRecord({ ts: 'ts', session: 's1', mode: 'on', sent: false }, PENDING)
    expect(refused).toMatchObject({ arm: 'fire', sent: false, text: nudgeText(12.4) })
  })

  test('afterStep: a later step adds one step and its tool calls by name', () => {
    const one = afterStep(PENDING, ['Read', 'Agent', 'Read'])
    expect(one).toMatchObject({ steps: 1, tools: { Read: 2, Agent: 1 } })
    expect(afterStep(one, [])).toMatchObject({ steps: 2, tools: { Read: 2, Agent: 1 } })
    expect(PENDING.tools).toEqual({})
  })

  test('afterStep: a tool named like an object member is counted as any other', () => {
    expect(afterStep(afterStep(PENDING, ['constructor']), ['constructor', '__proto__']).tools).toEqual({ constructor: 2, ['__proto__']: 1 })
  })

  test('outcomeRecord: joins the trigger by turn and threshold, and says what the turn did afterwards', () => {
    const p = afterStep(afterStep(PENDING, ['Agent', 'Read']), [])
    expect(outcomeRecord({ ts: 'ts', session: 's1', now: 9500, growth: 14.9, aborted: false }, p)).toEqual({
      schema: 1, kind: 'outcome', rev: STEER_REV, ts: 'ts', session: 's1', turn: 't1', threshold: 10, arm: 'fire',
      steps_after: 2, tools_after: 2, tool_names: { Agent: 1, Read: 1 }, growth_after: 2.5, ms_after: 4500, aborted: false,
    })
  })

  test('outcomeRecord: an unmeasured end has no growth after, and an aborted turn says so', () => {
    expect(outcomeRecord({ ts: 'ts', session: 's1', now: 6000, growth: null, aborted: true }, PENDING)).toMatchObject({
      steps_after: 0, tools_after: 0, tool_names: {}, growth_after: null, ms_after: 1000, aborted: true,
    })
  })

  test('the log has its own file beside the memory shadow log', () => {
    expect(STEER_LOG).toBe('steer.jsonl')
  })
})
