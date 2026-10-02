import { describe, expect, test } from 'claude-code/testing'

import { appendTail, shimmerSegments, wrapTail } from './lib'

describe('appendTail', () => {
  test('collapses whitespace runs, newlines included', () => {
    expect(appendTail('a  b', '\n\n c\t', 200)).toBe('a b c ')
  })

  test('over max, trims to half at once so the wrap stays put between trims', () => {
    expect(appendTail('abcdefgh', 'ij', 8)).toBe('ghij')
  })

  test('the trim starts after a space when one is in the kept half', () => {
    expect(appendTail('aaaa bbbb cc', 'dd', 12)).toBe('ccdd')
    expect(appendTail('aaaaaa bb c', 'dd', 12)).toBe('bb cdd')
  })

  test('never splits a surrogate pair when trimming', () => {
    expect(appendTail('abcde😀f', 'g', 7)).toBe('😀fg')
  })
})

describe('wrapTail', () => {
  test('fits in one line unchanged', () => {
    expect(wrapTail('short line', 20, 3)).toEqual(['short line'])
  })

  test('greedy word wrap one cell short of width, newest line last', () => {
    expect(wrapTail('the quick brown fox jumps over', 11, 3)).toEqual(['the quick', 'brown fox', 'jumps over'])
  })

  test('keeps the last rows; the first kept line gets an ellipsis', () => {
    expect(wrapTail('one two three four five six', 9, 2)).toEqual(['…four', 'five six'])
  })

  test('the ellipsis never pushes a line past width', () => {
    expect(wrapTail('aaaa bbbbbbbbb cc', 9, 2)).toEqual(['…bbbbbbbb', 'b cc'])
  })

  test('hard-splits a word longer than width', () => {
    expect(wrapTail('/a/very/long/path', 6, 3)).toEqual(['…ry/lo', 'ng/pa', 'th'])
  })

  test('counts code points', () => {
    expect(wrapTail('😀😀😀 😀😀', 4, 2)).toEqual(['😀😀😀', '😀😀'])
  })

  test('empty or blank text gives no lines', () => {
    expect(wrapTail('  ', 10, 3)).toEqual([])
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

  test('with a span, the window sweeps the whole band and the row sits at its right edge', () => {
    // 'ab' right-aligned in a 10-cell band occupies cells 8-9: the window's edge reaches cell 9 at phase 9
    expect(shimmerSegments('ab', 9, 4, 10)).toEqual([
      { text: 'a', dim: false },
      { text: 'b', dim: true },
    ])
    expect(shimmerSegments('ab', 5, 4, 10)).toEqual([{ text: 'ab', dim: true }])
  })

  test('with a span, a short row repeats every span + window ticks, not every row length + window', () => {
    expect(shimmerSegments('ab', 9 + 14, 4, 10)).toEqual(shimmerSegments('ab', 9, 4, 10))
    expect(shimmerSegments('ab', 9 + 6, 4, 10)).toEqual([{ text: 'ab', dim: true }])
  })

  test('a span shorter than the row is the row', () => {
    expect(shimmerSegments('abcdefgh', 6, 4, 3)).toEqual(shimmerSegments('abcdefgh', 6, 4))
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
