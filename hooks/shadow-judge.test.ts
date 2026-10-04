import { describe, expect, test } from 'claude-code/testing'

import { buildRecords, parseVerdicts, toStaging } from './shadow-judge'

describe('parseVerdicts', () => {
  test('one verdict per candidate, by index; a missing index is an error', () => {
    const reply = 'Sure: {"verdicts":[{"i":1,"verdict":"drop","reason":"task status"},{"i":0,"verdict":"keep","fact":"dreeft: $.fs has no append.","type":"project","name":"Fs No Append","topic":"context-dreeft","keywords":["fs","append"],"importance":"high","reason":"gotcha"}]}'
    const [keep, drop, missing] = parseVerdicts(reply, 3)
    expect(keep).toEqual({ verdict: 'keep', fact: 'dreeft: $.fs has no append.', type: 'project', name: 'fs-no-append', topic: 'context-dreeft', keywords: ['fs', 'append'], importance: 'high', reason: 'gotcha' })
    expect(drop).toMatchObject({ verdict: 'drop', fact: null, reason: 'task status' })
    expect(missing).toMatchObject({ verdict: 'error' })
  })
  test('a reply that is not JSON, or a keep without a fact, is an error verdict', () => {
    expect(parseVerdicts('no', 1)[0]).toMatchObject({ verdict: 'error', reason: 'judge reply was not JSON' })
    expect(parseVerdicts('{"verdicts":[{"i":0,"verdict":"keep"}]}', 1)[0]).toMatchObject({ verdict: 'error' })
  })
})

describe('records', () => {
  const ctx = { ts: '2026-10-02T00:00:00.000Z', session: 's1', turn: 't1', project: 'https://github.com/a/b.git', root: '/repo' }
  const judge = { model: 'claude-haiku-4-5-20251001', candidates: 1, input_tokens: 900, output_tokens: 80 }
  const [keep] = parseVerdicts('{"verdicts":[{"i":0,"verdict":"keep","fact":"b: the log appends with sh.","type":"project","name":"log-appends","topic":"decisions-b","keywords":["log"],"importance":"medium","reason":"decision"}]}', 1)
  const [record] = buildRecords(ctx, [{ source: 'hedge', span: 'Actually, sh appends.', evidence: null }], keep ? [keep] : [], judge)

  test('a record carries the candidate, the confirmed flag, the verdict and the judge cost', () => {
    expect(record).toEqual({
      schema: 1, ...ctx, source: 'hedge', term: null, span: 'Actually, sh appends.', evidence: null, confirmed: false, judge,
      verdict: 'keep', fact: 'b: the log appends with sh.', type: 'project', name: 'log-appends', topic: 'decisions-b', keywords: ['log'], importance: 'medium', reason: 'decision',
    })
  })
  test('a kept record converts to the flush staging shape; a dropped one does not', () => {
    const staged = record && toStaging(record)
    expect(staged).toMatchObject({ created_at: ctx.ts, session: 's1', type: 'project', name: 'log-appends', description: 'b: the log appends with sh.' })
    expect(staged?.body).toContain('**Evidence:** unconfirmed')
    expect(record && toStaging({ ...record, verdict: 'drop' })).toBeNull()
  })
})
