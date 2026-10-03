import { describe, expect, test } from 'claude-code/testing'

import { SPAN_MAX, buildRecords, findEvidence, hedgeSpans, parseVerdicts, repeatedTerms, selectCandidates, toStaging } from './shadow'
import type { ShadowTurn, ToolEvidence } from './shadow'

const tool = (over: Partial<ToolEvidence> = {}): ToolEvidence => ({ name: 'Bash', terms: [], text: '', isError: false, ...over })
const turnOf = (over: Partial<ShadowTurn> = {}): ShadowTurn => ({ turnId: 't1', thinking: '', text: '', tools: [], ...over })

describe('hedgeSpans', () => {
  test('a marker followed by a corrected belief yields the marker through the next sentence', () => {
    const spans = hedgeSpans('Reading the hook. Actually, the fs noun has no append call at all. So appends go through sh. Done.')
    expect(spans).toEqual(['Actually, the fs noun has no append call at all. So appends go through sh.'])
  })
  test('a plan, a question or a stall after the marker is not a candidate', () => {
    expect(hedgeSpans('Wait, let me check the types file for the model noun first.')).toEqual([])
    expect(hedgeSpans('Hmm, does the engine hand tool results to turn.step at all?')).toEqual([])
    expect(hedgeSpans('Hmm. Okay.')).toEqual([])
  })
  test('a dot inside a file name does not end the sentence', () => {
    const [span] = hedgeSpans('Wait, register.tsx imports lib.ts and never the testkit module directly.')
    expect(span).toBe('Wait, register.tsx imports lib.ts and never the testkit module directly.')
  })
  test('a marker inside an earlier span starts no second span', () => {
    expect(hedgeSpans('Actually the cache is per session and wait times never reset it here.')).toHaveLength(1)
  })
  test('spans are clipped', () => {
    const [span] = hedgeSpans(`Actually ${'the store keeps every row '.repeat(40)}.`)
    expect(span?.length).toBe(SPAN_MAX)
  })
})

describe('repeatedTerms', () => {
  test('counts names across thinking and tool calls; one mention is not focus', () => {
    const turn = turnOf({ thinking: 'Open `metaRow` and check `focusRow`.', tools: [tool({ terms: ['metaRow'] })] })
    expect(repeatedTerms(turn)).toEqual([{ t: 'metaRow', n: 2 }])
  })
})

describe('findEvidence', () => {
  test('the last successful tool call that names the term, snippet around it', () => {
    const turn = turnOf({
      tools: [tool({ name: 'Read', terms: ['lib.ts'], text: 'old' }), tool({ name: 'Grep', text: 'hooks/lib.ts:12 export function metaRow' }), tool({ text: 'lib.ts failed', isError: true })],
    })
    expect(findEvidence(turn, ['lib.ts'])).toEqual({ from: 'tool', tool: 'Grep', snippet: 'hooks/lib.ts:12 export function metaRow' })
  })
  test('falls back to the answer sentence naming the term', () => {
    const turn = turnOf({ text: 'Fixed it. The cap lives in `shadow.ts` now. Tests pass.' })
    expect(findEvidence(turn, ['shadow.ts'])).toEqual({ from: 'text', snippet: 'The cap lives in `shadow.ts` now.' })
  })
  test('nothing names the term: no evidence', () => {
    expect(findEvidence(turnOf({ text: 'Done.' }), ['shadow.ts'])).toBeNull()
    expect(findEvidence(turnOf({ text: 'Done.' }), [])).toBeNull()
  })
})

describe('selectCandidates', () => {
  const turn = turnOf({
    thinking: 'The band reads `trailOf` twice. Actually, `trailOf` drops the newest entry once the turn is done, not before.\n\nCheck `trailOf` again.',
    tools: [tool({ name: 'Read', terms: ['trailOf'], text: 'function trailOf(t) { return t.done ? t.trail.slice(0, -1) : t.trail }' })],
    text: 'Confirmed.',
  })
  test('hedge spans first, then repeated names the thinking discussed, each with evidence', () => {
    const got = selectCandidates(turn)
    expect(got.map(c => c.source)).toEqual(['hedge', 'focus'])
    expect(got[0]?.evidence).toMatchObject({ from: 'tool', tool: 'Read' })
    expect(got[1]).toMatchObject({ term: 'trailOf', evidence: { from: 'tool' } })
  })
  test('a candidate without evidence is still selected, unconfirmed', () => {
    const got = selectCandidates(turnOf({ thinking: 'Actually, the session id survives a hot reload of the module entirely.' }))
    expect(got).toEqual([{ source: 'hedge', span: 'Actually, the session id survives a hot reload of the module entirely.', evidence: null }])
  })
  test('a name only tool calls repeated is not a candidate', () => {
    expect(selectCandidates(turnOf({ tools: [tool({ terms: ['a.ts'] }), tool({ terms: ['a.ts'] })] }))).toEqual([])
  })
})

describe('parseVerdicts', () => {
  test('one verdict per candidate, by index; a missing index is an error', () => {
    const reply = 'Sure: {"verdicts":[{"i":1,"verdict":"drop","reason":"task status"},{"i":0,"verdict":"keep","fact":"whispered-thoughts: $.fs has no append.","type":"project","name":"Fs No Append","topic":"context-whispered-thoughts","keywords":["fs","append"],"importance":"high","reason":"gotcha"}]}'
    const [keep, drop, missing] = parseVerdicts(reply, 3)
    expect(keep).toEqual({ verdict: 'keep', fact: 'whispered-thoughts: $.fs has no append.', type: 'project', name: 'fs-no-append', topic: 'context-whispered-thoughts', keywords: ['fs', 'append'], importance: 'high', reason: 'gotcha' })
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
