import { describe, expect, test } from 'claude-code/testing'

import type { ShadowTurn, ToolEvidence } from './shadow'
import { SPAN_MAX, findEvidence, hedgeSpans, redact, repeatedTerms, selectCandidates } from './shadow-candidates'

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
  test('a relative path or a spread before the plan does not hide the plan', () => {
    expect(hedgeSpans('Wait, let me check ../hooks/rows.ts and ...args before anything else here.')).toEqual([])
  })
  test('a sentence keeps the text before a `../` path', () => {
    const [span] = hedgeSpans('Actually the helper in ../hooks/rows.ts never reads the trail at all.')
    expect(span).toBe('Actually the helper in ../hooks/rows.ts never reads the trail at all.')
  })
  test('only the first four spans are built, however many markers follow', () => {
    const thinking = 'Actually, the store keeps every row it was ever given. Fine. '.repeat(50)
    expect(hedgeSpans(thinking)).toHaveLength(4)
  })
  test('spans are clipped', () => {
    const [span] = hedgeSpans(`Actually ${'the store keeps every row '.repeat(40)}.`)
    expect(span?.length).toBe(SPAN_MAX)
  })
})

describe('redact', () => {
  test('an assignment to a secret-named key loses its value and keeps its name', () => {
    expect(redact('STRIPE_SECRET_KEY=sk_live_abc123 PORT=3000')).toBe('STRIPE_SECRET_KEY=[redacted] PORT=3000')
    expect(redact('"apiKey": "abc def", password: hunter2')).toBe('"apiKey": [redacted], password: [redacted]')
  })
  test('credentials inside a URL go, the host stays', () => {
    expect(redact('DATABASE_URL=postgres://u:pw@db/prod')).toBe('DATABASE_URL=postgres://[redacted]@db/prod')
  })
  test('a bare token is recognised by its shape', () => {
    expect(redact('got ghp_0123456789abcdefghijABCDEFGHIJ and AKIAABCDEFGHIJKLMNOP')).toBe('got [redacted] and [redacted]')
    expect(redact('Authorization: Bearer abcdef0123456789')).toBe('Authorization: Bearer [redacted]')
  })
  test('ordinary code and prose pass through', () => {
    const text = 'const key = tokens.length; see hooks/turn.ts:12 and user@example.com'
    expect(redact(text)).toBe(text)
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
  test('a secret in a tool result is redacted in the snippet, even when the cut would split it', () => {
    const env = `${'# comment line\n'.repeat(20)}STRIPE_SECRET_KEY=sk_live_abc123\nDATABASE_URL=postgres://u:pw@db/prod\n`
    const got = findEvidence(turnOf({ tools: [tool({ name: 'Read', terms: ['.env'], text: env })] }), ['.env'])
    expect(got?.snippet).not.toContain('sk_live_abc123')
    expect(got?.snippet).not.toContain('u:pw')
    const cut = findEvidence(turnOf({ tools: [tool({ text: `${'x'.repeat(145)} PASSWORD=hunter2 for db.ts` })] }), ['db.ts'])
    expect(cut?.snippet).not.toContain('hunter2')
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
  test('a name whose mentions a hedge span already holds is not a second candidate', () => {
    const got = selectCandidates(turnOf({ thinking: 'Actually, `trailOf` drops the newest entry and `trailOf` keeps every null in place.' }))
    expect(got.map(c => c.source)).toEqual(['hedge'])
  })
  test('a secret the thinking repeats is redacted in the span', () => {
    const [got] = selectCandidates(turnOf({ thinking: 'Actually, the deploy script reads API_TOKEN=abc123456 from the env file every run.' }))
    expect(got?.span).toBe('Actually, the deploy script reads API_TOKEN=[redacted] from the env file every run.')
  })
  test('at most six candidates: four hedges, then two names', () => {
    const hedges = ['cache', 'store', 'queue', 'index', 'buffer'].map(n => `Actually, the ${n} module keeps every row it was ever given.`).join(' Fine. ')
    const names = ['`aOne` then `aOne`.', '`bTwo` then `bTwo`.', '`cThree` then `cThree`.'].join(' ')
    const got = selectCandidates(turnOf({ thinking: `${hedges} Fine. ${names}` }))
    expect(got.map(c => c.source)).toEqual(['hedge', 'hedge', 'hedge', 'hedge', 'focus', 'focus'])
  })
  test('a name only tool calls repeated is not a candidate', () => {
    expect(selectCandidates(turnOf({ tools: [tool({ terms: ['a.ts'] }), tool({ terms: ['a.ts'] })] }))).toEqual([])
  })
})
