export type Run = { text: string; dim: boolean }

/** Append a thinking piece, collapse whitespace, keep the last `max` code points. */
export function appendTail(prev: string, piece: string, max: number): string {
  const joined = (prev + piece).replace(/\s+/g, ' ')
  const points = Array.from(joined)
  return points.length <= max ? joined : points.slice(-max).join('')
}

/** Fit `buf` into `width` cells from its end, `…`-prefixed, cut after a space when one is near. */
export function clipTail(buf: string, width: number): string {
  const points = Array.from(buf)
  if (points.length <= width) return buf
  let suffix = points.slice(-(width - 1))
  const space = suffix.slice(0, 12).indexOf(' ')
  if (space !== -1) suffix = suffix.slice(space + 1)
  while (suffix[0] === ' ') suffix = suffix.slice(1)
  return '…' + suffix.join('')
}

/**
 * Split `text` into dim and bright runs. The bright window's right edge sits at
 * `phase % (len + window)`, so it enters from the left, crosses, and leaves.
 */
export function shimmerSegments(text: string, phase: number, window: number): Run[] {
  const points = Array.from(text)
  if (points.length === 0) return []
  const end = phase % (points.length + window)
  const start = Math.max(0, end - window)
  const stop = Math.min(points.length, end)
  if (stop <= start) return [{ text, dim: true }]
  const runs: Run[] = []
  const push = (from: number, to: number, dim: boolean) => {
    if (to > from) runs.push({ text: points.slice(from, to).join(''), dim })
  }
  push(0, start, true)
  push(start, stop, false)
  push(stop, points.length, true)
  return runs
}

export type Tone = 'dim' | 'bright' | 'warn'
export type Seg = { text: string; tone: Tone }
export type Meta = { thinkMs: number; blocks: number; outTok: number }

export const TRAIL_CELLS = 10
const LEFT = [0, 0x40, 0x44, 0x46, 0x47]
const RIGHT = [0, 0x80, 0xa0, 0xb0, 0xb8]

/** Two values per braille cell, each 0..100 drawn as 0-4 dots rising from the bottom. */
export function braille(values: number[]): string {
  const level = (v: number) => Math.max(0, Math.min(4, Math.round((v / 100) * 4)))
  let out = ''
  for (let i = 0; i < values.length; i += 2) {
    out += String.fromCharCode(0x2800 + (LEFT[level(values[i] ?? 0)] ?? 0) + (RIGHT[level(values[i + 1] ?? 0)] ?? 0))
  }
  return out
}

/**
 * Per-turn growth as braille: `past` holds earlier turns, `now` the newest cell. Scales to the
 * largest value shown; every real turn gets at least one dot (negatives count as 0), padding none.
 */
export function growthTrail(history: number[], current: number | null, cells: number): { past: string; now: string } {
  const real = [...history, current ?? 0].map(v => Math.max(0, v)).slice(-cells * 2)
  const max = Math.max(...real) || 1
  const levels = real.map(v => Math.max(1, Math.round((v / max) * 4)))
  while (levels.length < cells * 2) levels.unshift(0)
  const draw = (ls: number[]) => {
    let out = ''
    for (let k = 0; k < ls.length; k += 2) out += String.fromCharCode(0x2800 + (LEFT[ls[k] ?? 0] ?? 0) + (RIGHT[ls[k + 1] ?? 0] ?? 0))
    return out
  }
  return { past: draw(levels.slice(0, -2)), now: draw(levels.slice(-2)) }
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

export function formatGrowth(points: number): string {
  const abs = Math.abs(points)
  const body = abs < 10 ? abs.toFixed(1) : String(Math.round(abs))
  return (points < 0 && body !== '0.0' ? '-' : '+') + body + '%'
}

const width = (segs: Seg[]) => segs.reduce((n, s) => n + Array.from(s.text).length, 0)

/** Row 2, fitted to `max` cells: drop the trail, then the token count, then the whole row. */
export function metaRow(meta: Meta, growth: number | null, history: number[], max: number): Seg[] {
  const head = `◆ ${Math.round(meta.thinkMs / 1000)}s · ${meta.blocks} blk`
  const out = ` · ${formatTokens(meta.outTok)} out`
  if (growth === null) {
    return [[{ text: head + out, tone: 'dim' as Tone }], [{ text: head, tone: 'dim' as Tone }]].find(c => width(c) <= max) ?? []
  }
  const tone: Tone = growth >= 10 ? 'warn' : 'bright'
  const g: Seg[] = [{ text: '   ', tone: 'dim' }, { text: formatGrowth(growth), tone }]
  const trail = growthTrail(history, growth, TRAIL_CELLS)
  const t: Seg[] = [{ text: ' ' + trail.past, tone: 'dim' }, { text: trail.now, tone }]
  const candidates: Seg[][] = [
    [{ text: head + out, tone: 'dim' }, ...g, ...t],
    [{ text: head + out, tone: 'dim' }, ...g],
    [{ text: head, tone: 'dim' }, ...g],
  ]
  return candidates.find(c => width(c) <= max) ?? []
}
