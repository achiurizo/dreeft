import { describe, expect, test } from 'claude-code/testing'

import { appendTail, clipTail, shimmerSegments } from './lib'

describe('appendTail', () => {
  test('collapses whitespace runs, newlines included', () => {
    expect(appendTail('a  b', '\n\n c\t', 200)).toBe('a b c ')
  })

  test('keeps the last max code points', () => {
    expect(appendTail('abcdef', 'gh', 4)).toBe('efgh')
  })

  test('never splits a surrogate pair when trimming', () => {
    expect(appendTail('x😀y', 'z', 3)).toBe('😀yz')
  })
})

describe('clipTail', () => {
  test('fits unchanged', () => {
    expect(clipTail('short line', 20)).toBe('short line')
  })

  test('overflow gets an ellipsis and cuts after a space', () => {
    expect(clipTail('the quick brown fox jumps over', 20)).toBe('…fox jumps over')
  })

  test('hard-cuts text with no space in the window', () => {
    const out = clipTail('/a/very/long/path/without/any/spaces/at/all', 16)
    expect(out).toBe('…y/spaces/at/all')
    expect(Array.from(out)).toHaveLength(16)
  })

  test('counts code points, so emoji at the cut stay whole', () => {
    expect(clipTail('😀😀😀😀😀😀😀😀😀😀', 5)).toBe('…😀😀😀😀')
  })

  test('drops leading space after the ellipsis', () => {
    expect(clipTail('aaaaaaaaaa bbbb', 6)).toBe('…bbbb')
  })
})

describe('shimmerSegments', () => {
  test('phase 0: window not yet entered, all dim', () => {
    expect(shimmerSegments('abcdefgh', 0, 4)).toEqual([{ text: 'abcdefgh', dim: true }])
  })

  test('window partly on the left edge', () => {
    expect(shimmerSegments('abcdefgh', 2, 4)).toEqual([
      { text: 'ab', dim: false },
      { text: 'cdefgh', dim: true },
    ])
  })

  test('window in the middle', () => {
    expect(shimmerSegments('abcdefgh', 6, 4)).toEqual([
      { text: 'ab', dim: true },
      { text: 'cdef', dim: false },
      { text: 'gh', dim: true },
    ])
  })

  test('window partly off the right edge', () => {
    expect(shimmerSegments('abcdefgh', 10, 4)).toEqual([
      { text: 'abcdef', dim: true },
      { text: 'gh', dim: false },
    ])
  })

  test('phase wraps after text.length + window', () => {
    expect(shimmerSegments('abcdefgh', 12 + 6, 4)).toEqual(shimmerSegments('abcdefgh', 6, 4))
  })

  test('never returns an empty run', () => {
    for (let p = 0; p < 30; p++) {
      for (const run of shimmerSegments('abcdefgh', p, 4)) {
        expect(run.text.length).toBeGreaterThan(0)
      }
    }
  })

  test('empty text gives no runs', () => {
    expect(shimmerSegments('', 3, 4)).toEqual([])
  })
})
