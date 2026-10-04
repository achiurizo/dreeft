// Draws the README's images from the mod's own row builders: `bun scripts/readme-images.ts`.
// One scripted turn feeds every image, so the numbers agree across the page.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CORNER, FOCUS_TERMS, addTerms, bandWidth, width as cells, focusRow, metaRow, phaseTotals, timelineRow, topTerms } from '../hooks/lib'
import type { Seg, Tone } from '../hooks/lib'
import type { Span, Trail } from '../types'

const OUT = join(import.meta.dir, '..', 'assets')

// The scripted turn: 31 seconds, two thinking blocks, three tool calls.
const START = 0
const END = 31_000
const SPANS: Span[] = [
  { phase: 'wait', at: 0 },
  { phase: 'think', at: 300 },
  { phase: 'tool', at: 5_000 },
  { phase: 'wait', at: 14_000 },
  { phase: 'think', at: 15_000 },
  { phase: 'tool', at: 21_000 },
  { phase: 'wait', at: 25_000 },
  { phase: 'write', at: 26_000 },
]
const MENTIONS: [string, number][] = [
  ['observe', 2],
  ['metaRow', 4],
  ['register.tsx', 6],
]
const FOCUS = addTerms(
  [],
  MENTIONS.flatMap(([name, n]) => Array<string>(n).fill(name)),
)
const HEDGES = 2
const META = { thinkMs: phaseTotals(SPANS, END).think, blocks: 2, tools: 3 }
const GROWTH = 0.6
/** Earlier turns' growth in points of the window; null is a compaction. */
const HISTORY: Trail = [1.2, 0.4, 2.1, 3, 0.8, 1.5, 4.2, 2.6, 3.4, null, 0.3, 0.9, 1.4, 2.2, 2.9, 3.6, 1.1, 1.8, 2.7, 4]

// The band's layout in a 112-column terminal.
const COLUMNS = 112
const BAND = bandWidth(COLUMNS) ?? 0

const focus = (max: number) => focusRow(topTerms(FOCUS, FOCUS_TERMS), HEDGES, max)
const timeline = (max: number) => timelineRow(SPANS, START, END, max)
const meta = (max: number) => metaRow(META, GROWTH, HISTORY, max)

// Drawing.

const INK = {
  bg: '#0d1117',
  edge: '#30363d',
  fg: '#e6edf3',
  dim: '#7d8590',
  faint: '#484f58',
  yellow: '#e3b341',
  blue: '#58a6ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
}
interface Palette {
  think: string
  tool: string
}
/** The `palette` setting's four values, as `hooks/register.tsx` draws them: a dim cell is a gray one here. */
const PALETTES = {
  mono: { think: INK.fg, tool: INK.dim },
  amber: { think: INK.yellow, tool: INK.dim },
  blue: { think: INK.blue, tool: INK.dim },
  magenta: { think: INK.magenta, tool: INK.cyan },
} satisfies Record<string, Palette>

const FONT = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace`
/** A terminal cell at scale 1, in pixels. */
const CELL = { w: 9, h: 20, font: 15 }
const PAD = 24

const px = (n: number) => String(Math.round(n * 100) / 100)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const plain = (segs: Seg[]) => segs.map(s => s.text).join('')

function inkOf(tone: Tone, palette: Palette): string {
  switch (tone) {
    case 'faint':
      return INK.faint
    case 'dim':
      return INK.dim
    case 'warn':
      return INK.yellow
    case 'think':
      return palette.think
    case 'tool':
      return palette.tool
    case 'bright':
      return INK.fg
  }
}

/** The part of a cell a block glyph fills, as fractions of the cell: x, y, width, height. */
const BLOCKS: Record<string, [number, number, number, number]> = {
  '▀': [0, 0, 1, 0.5],
  '▄': [0, 0.5, 1, 0.5],
  '█': [0, 0, 1, 1],
  '▕': [0.875, 0, 0.125, 1],
}
/** Braille dot bits, by column then row from the top. */
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/**
 * A row of segments as SVG, its first cell's top-left corner at (x0, y). Blocks and braille are
 * drawn as shapes and every other glyph is centered in its own cell, so the row keeps its alignment
 * in whatever monospace font the viewer has.
 */
function draw(segs: Seg[], x0: number, y: number, scale: number, palette: Palette): string {
  const w = CELL.w * scale
  const h = CELL.h * scale
  const out: string[] = []
  let col = 0
  for (const seg of segs) {
    const fill = inkOf(seg.tone, palette)
    const glyphs: string[] = []
    let run: { glyph: string; from: number; n: number } | null = null
    const endRun = () => {
      const box = run === null ? undefined : BLOCKS[run.glyph]
      if (run !== null && box !== undefined) {
        const [bx, by, bw, bh] = box
        const rx = x0 + (run.from + bx) * w
        out.push(`<rect x="${px(rx)}" y="${px(y + by * h)}" width="${px((run.n - 1 + bw) * w)}" height="${px(bh * h)}" fill="${fill}"/>`)
      }
      run = null
    }
    for (const ch of seg.text) {
      const code = ch.codePointAt(0) ?? 0
      if (run !== null && run.glyph !== ch) endRun()
      if (ch in BLOCKS) {
        run = run === null ? { glyph: ch, from: col, n: 1 } : { ...run, n: run.n + 1 }
      } else if (code >= 0x2800 && code <= 0x28ff) {
        DOTS.forEach((bits, c) =>
          bits.forEach((bit, r) => {
            if ((code - 0x2800) & bit) {
              const cx = x0 + (col + 0.28 + 0.44 * c) * w
              out.push(`<circle cx="${px(cx)}" cy="${px(y + (0.24 + 0.18 * r) * h)}" r="${px(0.12 * w)}" fill="${fill}"/>`)
            }
          }),
        )
      } else if (ch !== ' ') {
        glyphs.push(`<text x="${px(x0 + (col + 0.5) * w)}" y="${px(y + 0.74 * h)}">${esc(ch)}</text>`)
      }
      col++
    }
    endRun()
    if (glyphs.length > 0) {
      out.push(`<g font-size="${px(CELL.font * scale)}" text-anchor="middle" fill="${fill}">${glyphs.join('')}</g>`)
    }
  }
  return out.join('\n')
}

/** A dark terminal card of the given size around `body`. */
function card(width: number, height: number, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="0 0 ${px(width)} ${px(height)}" font-family="${FONT}">`,
    `<rect x="0.5" y="0.5" width="${px(width - 1)}" height="${px(height - 1)}" rx="10" fill="${INK.bg}" stroke="${INK.edge}"/>`,
    body,
    '</svg>',
    '',
  ].join('\n')
}

// Images.

/** A label under the cells that hold `find`, the first match in the row's text. */
interface Callout {
  find: string
  label: string
}
const LABEL = { font: 13, w: 7.8, tier: 22 }

/** One row, enlarged, with a bracket and a label under each called-out part. */
function rowImage(segs: Seg[], callouts: Callout[]): string {
  const scale = 1.5
  const w = CELL.w * scale
  const h = CELL.h * scale
  const width = PAD * 2 + cells(segs) * w
  const text = Array.from(plain(segs))
  const bracketY = PAD + h + 8
  /** The right edge of the last label on each tier. */
  const tiers: number[] = []
  const marks = callouts.map(({ find, label }) => {
    const needle = Array.from(find)
    const at = text.findIndex((_, i) => needle.every((ch, k) => text[i + k] === ch))
    if (at < 0) throw new Error(`callout not in row: ${find}`)
    const from = PAD + at * w
    const to = from + needle.length * w
    const half = (label.length * LABEL.w) / 2
    const mid = Math.max(PAD + half, Math.min(width - PAD - half, (from + to) / 2))
    let tier = tiers.findIndex(edge => edge + 12 <= mid - half)
    if (tier < 0) tier = tiers.length
    tiers[tier] = mid + half
    return { from, to, mid, tier, label }
  })
  const body = marks.map(({ from, to, mid, tier, label }) => {
    const stem = (from + to) / 2
    const labelY = bracketY + 20 + tier * LABEL.tier
    return [
      `<path d="M${px(from + 1)} ${px(bracketY - 3)}V${px(bracketY)}H${px(to - 1)}V${px(bracketY - 3)}M${px(stem)} ${px(bracketY)}V${px(labelY - 13)}" fill="none" stroke="${INK.faint}"/>`,
      `<text x="${px(mid)}" y="${px(labelY)}" font-size="${LABEL.font}" text-anchor="middle" fill="${INK.dim}">${esc(label)}</text>`,
    ].join('\n')
  })
  const height = bracketY + 20 + (tiers.length - 1) * LABEL.tier + PAD - 6
  return card(width, height, [draw(segs, PAD, PAD, scale, PALETTES.mono), ...body].join('\n'))
}

/** The whole band above the prompt, in a terminal `COLUMNS` wide. */
function bandImage(): string {
  const width = PAD * 2 + COLUMNS * CELL.w
  const lines: Seg[][] = [
    [
      { text: '> ', tone: 'dim' },
      { text: 'the meta row overflows in a narrow terminal, fix it', tone: 'bright' },
    ],
    [],
    [
      { text: '● ', tone: 'bright' },
      { text: 'Fixed. The meta row now drops its tool count first, then the trail.', tone: 'bright' },
    ],
    [],
    // The top row stops short of the corner, where the engine draws the band's collapse mark.
    [...focus(BAND - CORNER), { text: ' [-]', tone: 'faint' }],
    timeline(BAND),
    meta(BAND),
  ]
  const top = 44
  const rows = lines.map((segs, i) => {
    const banded = i >= 4
    return draw(segs, PAD + (banded ? COLUMNS - cells(segs) : 0) * CELL.w, top + i * CELL.h, 1, PALETTES.mono)
  })
  const promptY = top + lines.length * CELL.h + 10
  const prompt = [
    `<rect x="${PAD - 10}" y="${promptY}" width="${px(width - 2 * PAD + 20)}" height="${CELL.h + 16}" rx="6" fill="none" stroke="${INK.edge}"/>`,
    draw([{ text: '> ', tone: 'dim' }, { text: '█', tone: 'dim' }], PAD, promptY + 8, 1, PALETTES.mono),
  ]
  const chrome = ['#ff5f57', '#febc2e', '#28c840'].map((fill, i) => `<circle cx="${22 + i * 18}" cy="20" r="5.5" fill="${fill}"/>`)
  return card(width, promptY + CELL.h + 16 + PAD - 6, [...chrome, ...rows, ...prompt].join('\n'))
}

/** The timeline row once per palette, each under its setting's name. */
function palettesImage(): string {
  const scale = 1.25
  const h = CELL.h * scale
  const row = timeline(BAND)
  const gutter = 10
  const names = Object.entries(PALETTES)
  const body = names.map(([name, palette], i) => {
    const y = PAD + i * (h + 16)
    return [
      draw([{ text: name, tone: 'dim' }], PAD, y, scale, palette),
      draw(row, PAD + gutter * CELL.w * scale, y, scale, palette),
    ].join('\n')
  })
  const width = PAD * 2 + (gutter + cells(row)) * CELL.w * scale
  return card(width, PAD * 2 + names.length * (h + 16) - 16, body.join('\n'))
}

const IMAGES: Record<string, string> = {
  'band.svg': bandImage(),
  'row-focus.svg': rowImage(focus(BAND), [
    { find: 'register.tsx ×6 · metaRow ×4 · observe ×2', label: 'the names the turn keeps coming back to' },
    { find: '⟲ 2', label: 'second-guesses' },
  ]),
  'row-timeline.svg': rowImage(timeline(BAND), [
    { find: '▀▀▀▀▀', label: 'thinking' },
    { find: '▄▄▄▄▄▄▄▄▄', label: 'tool' },
    { find: ' ', label: 'waiting' },
    { find: '█████', label: 'writing' },
    { find: 'think 11s · tools 13s · write 5s', label: 'time in each phase' },
  ]),
  'row-meta.svg': rowImage(meta(BAND), [
    { find: '◆ 11s', label: 'thinking time' },
    { find: '2 blk', label: 'thinking blocks' },
    { find: '3 tools', label: 'tool calls' },
    { find: '+0.6%', label: 'context growth' },
    { find: plain(meta(BAND)).slice(-11), label: 'last 20 turns, ↓ compaction' },
  ]),
  'palettes.svg': palettesImage(),
}

mkdirSync(OUT, { recursive: true })
for (const [name, svg] of Object.entries(IMAGES)) {
  writeFileSync(join(OUT, name), svg)
  console.log(`assets/${name}`)
}
