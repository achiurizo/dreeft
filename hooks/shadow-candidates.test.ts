import { describe, expect, test } from 'claude-code/testing'

import { SCAN } from './focus'
import type { ShadowTurn, ToolEvidence } from './shadow'
import { REDACT_OVERLAP, SELECTION, SPAN_MAX, findEvidence, hedgeSpans, redact, repeatedTerms, selectCandidates } from './shadow-candidates'

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
    expect(hedgeSpans('Actually, the cache is kept per session for good. Wait, nothing ever resets it here.')).toHaveLength(1)
  })
  test('a relative path or a spread before the plan does not hide the plan', () => {
    expect(hedgeSpans('Wait, let me check ../hooks/rows.ts and ...args before anything else here.')).toEqual([])
  })
  test('a sentence keeps the text before a `../` path', () => {
    const [span] = hedgeSpans('Actually, the helper in ../hooks/rows.ts never reads the trail at all.')
    expect(span).toBe('Actually, the helper in ../hooks/rows.ts never reads the trail at all.')
  })
  test('only the first four spans are built, however many markers follow', () => {
    const thinking = 'Actually, the store keeps every row it was ever given. Fine. '.repeat(50)
    expect(hedgeSpans(thinking)).toHaveLength(4)
  })
  test('a narrated realization is a marker too', () => {
    const [span] = hedgeSpans('Reading the hook. I realize the fs noun has no append call at all. So appends go through sh.')
    expect(span).toBe('I realize the fs noun has no append call at all. So appends go through sh.')
  })
  test('the words as verb or adverb are no marker', () => {
    expect(hedgeSpans('Push both branches and wait for the checks to finish before the merge happens.')).toEqual([])
    expect(hedgeSpans('Check how the path resolution logic actually works before writing the test.')).toEqual([])
  })
  test('spans are clipped', () => {
    const [span] = hedgeSpans(`Actually, ${'the store keeps every row '.repeat(40)}.`)
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
  test('a vendor token is recognised by its prefix and its length', () => {
    const x = (n: number) => 'x'.repeat(n)
    const zeros = (n: number) => '0'.repeat(n)
    const tokens = [
      `AIza${x(35)}`, `glpat-${x(20)}`, `npm_${x(36)}`, `hf_${x(34)}`, `SG.${x(22)}.${x(43)}`,
      `whsec_${x(32)}`, `ya29.${x(40)}`, `ASIA${zeros(16)}`, `AGE-SECRET-KEY-1${zeros(58)}`,
    ]
    for (const t of tokens) expect(redact(`got ${t} back`)).toBe('got [redacted] back')
    expect(redact(`post to https://hooks.slack.com/services/T${zeros(8)}/B${zeros(8)}/${x(24)} now`))
      .toBe('post to https://hooks.slack.com/services/[redacted] now')
  })
  test('an AWS secret key beside its key id goes with it', () => {
    expect(redact(`AKIAIOSFODNN7EXAMPLE ${'x'.repeat(40)} us-east-1`)).toBe('[redacted] [redacted] us-east-1')
    expect(redact(`AKIAIOSFODNN7EXAMPLE,${'x'.repeat(40)}`)).toBe('[redacted],[redacted]')
  })
  test('a credential passed as a flag to a command that takes one is redacted', () => {
    expect(redact('mysql -u root --password hunter2 shop')).toBe('mysql -u root --password [redacted] shop')
    expect(redact('mysql -uroot -phunter2 shop')).toBe('mysql -uroot -p[redacted] shop')
    expect(redact('mysqldump -u root -p hunter2')).toBe('mysqldump -u root -p [redacted]')
    expect(redact('curl -u admin:hunter2 https://host/x')).toBe('curl -u [redacted] https://host/x')
    expect(redact('docker login -u bob -p hunter2 registry.io')).toBe('docker login -u bob -p [redacted] registry.io')
    expect(redact('sshpass -p hunter2 ssh host')).toBe('sshpass -p [redacted] ssh host')
    expect(redact('redis-cli -h cache -a hunter2 ping')).toBe('redis-cli -h cache -a [redacted] ping')
    expect(redact('htpasswd -b .htpasswd bob hunter2')).toBe('htpasswd -b .htpasswd bob [redacted]')
  })
  test('a short or header-style secret name loses its value too', () => {
    expect(redact('DB_PASS=hunter2 PORT=3000')).toBe('DB_PASS=[redacted] PORT=3000')
    expect(redact('PASSPHRASE=hunter2')).toBe('PASSPHRASE=[redacted]')
    expect(redact('pwd: hunter2')).toBe('pwd: [redacted]')
    expect(redact('SIGNING_KEY=abc123 ENCRYPTION_KEY=abc123')).toBe('SIGNING_KEY=[redacted] ENCRYPTION_KEY=[redacted]')
    expect(redact('Cookie: session=abc123; theme=dark\nAccept: */*')).toBe('Cookie: [redacted]\nAccept: */*')
    expect(redact('Set-Cookie: sid=abc123; HttpOnly')).toBe('Set-Cookie: [redacted]')
    expect(redact('X-Auth-Token: abc123')).toBe('X-Auth-Token: [redacted]')
    expect(redact('X-Auth: abc123')).toBe('X-Auth: [redacted]')
    expect(redact('Authorization: Token 0123456789abcdef')).toBe('Authorization: Token [redacted]')
    expect(redact('GET /obj?X-Amz-Signature=0123456789abcdef')).toBe('GET /obj?X-Amz-Signature=[redacted]')
  })
  test('a bare value goes whole, up to the next space', () => {
    expect(redact('PASSWORD=ab,cd;ef next')).toBe('PASSWORD=[redacted] next')
  })
  test('a quoted value goes whole: past an escaped quote, and to the end when the quote never closes', () => {
    expect(redact(String.raw`password: "ab\"cd ef" next`)).toBe('password: [redacted] next')
    expect(redact('password: "ab cd ef')).toBe('password: [redacted]')
  })
  test('a URL password holding a slash goes, the host stays', () => {
    expect(redact('https://user:pa/ss@host/db')).toBe('https://[redacted]@host/db')
  })
  test('ordinary names, flags and words that look like a secret shape pass through', () => {
    const plain = [
      'hf_hub_download', 'npm_config_registry', 'npm_package_version', 'mkdir -p dir', 'ssh -p 22 host',
      'docker run -p 8080:80 img', 'git log -p file.ts', 'psql -p 5432 shop', 'passed: 174', 'pass: 177', 'bypass=true',
      'compass: north', 'pwd', 'cd "$(pwd)"', 'PWD=/home/user/code', 'It ships to SG.', 'ASIAN markets', 'whsec',
      'Cookie banner: shown', 'Each token in the list is counted once, then the token count is printed.', 'curl -u',
      'curl --user-agent "probe: one" https://host/x', 'signature: (a: string) => void',
      'http://localhost:3000/@scope/pkg', 'https://example.com:8080/users?email=a@b.com',
    ]
    for (const text of plain) expect(redact(text)).toBe(text)
  })
  test('a megabyte built to stress one shape costs about what prose does', () => {
    const fill = (unit: string) => unit.repeat(Math.ceil(1_000_000 / unit.length))
    const stress = [
      'AIza', 'npm_', 'hf_', 'SG.', 'ya29.', 'whsec_', 'glpat-', 'ASIA', 'AGE-SECRET-KEY-1', 'eyJ-', 'token', 'pass_', '=', ':', '"', "'",
      'token="', String.raw`token="\"`, 'a://', 'a://a:', 'mysql ', 'curl -u ', 'htpasswd -b ', 'cookie:', 'authorization: ',
      'AKIAIOSFODNN7EXAMPLE ', `AKIAIOSFODNN7EXAMPLE${' '.repeat(100_000)}`, `AKIAIOSFODNN7EXAMPLE ${'x'.repeat(39)} `,
      'https://hooks.slack.com/services/T', '-----BEGIN A',
    ].map(fill)
    for (const text of stress) {
      const from = performance.now()
      redact(text)
      expect(performance.now() - from).toBeLessThan(1000)
    }
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
  test('a name shaped like a secret is not a focus candidate', () => {
    const pat = 'ghp_0123456789abcdefghijABCDEFGHIJ'
    const got = selectCandidates(turnOf({ thinking: `The push used \`${pat}\` first. Then the remote rejected \`${pat}\` as expired.` }))
    expect(JSON.stringify(got)).not.toContain(pat)
    expect(got.filter(c => c.source === 'focus')).toEqual([])
  })
  test('a punctuation run or one unbroken long sentence costs about what prose does', () => {
    const elapsed = (turn: ShadowTurn) => {
      const from = performance.now()
      selectCandidates(turn)
      return performance.now() - from
    }
    const dots = '.'.repeat(200_000)
    expect(elapsed(turnOf({ thinking: dots, text: dots }))).toBeLessThan(1000)
    const unbroken = `\`trailOf\` ${'token.'.repeat(3000)} \`trailOf\``
    expect(elapsed(turnOf({ thinking: unbroken, text: unbroken }))).toBeLessThan(1000)
  })
  test('a name that only starts like a vendor token is still a focus candidate', () => {
    const got = selectCandidates(turnOf({ thinking: 'The loader calls `hf_hub_download` once. Then `hf_hub_download` caches the file on disk.' }))
    expect(got.map(c => c.term)).toEqual(['hf_hub_download'])
  })
  test('a name only tool calls repeated is not a candidate', () => {
    expect(selectCandidates(turnOf({ tools: [tool({ terms: ['a.ts'] }), tool({ terms: ['a.ts'] })] }))).toEqual([])
  })
})

describe('SELECTION', () => {
  test('holds the redaction shapes, so a change to what the log hides shows in the code stamp', () => {
    expect(SELECTION).toContain('PRIVATE KEY')
    expect(SELECTION).toContain('[redacted]')
  })
  test('holds the overlap a tool result is redacted with, so a change to it shows in the code stamp', () => {
    expect(SELECTION.split('\n')).toContain(String(REDACT_OVERLAP))
  })
  test('holds the patterns that decide what a name is', () => {
    expect(SELECTION).toContain(SCAN)
    expect(SCAN).toContain('tsx?')
    expect(SCAN).toContain('Justfile')
    expect(SCAN).toContain('tmpl')
    expect(SCAN).toContain('\\\\')
  })
})
