/**
 * Generates every Aburi brand asset from a single source of truth: the mark's cell
 * pattern is the first 16 bits of the project's own fingerprint.
 *
 *   pattern = sha256("@aburi/core").hex.slice(0, 4) === "5e72"
 *
 * Each hex digit is one row of the 4x4 grid, most significant bit on the left. A set
 * bit is a filled square (the Symbol surfaced by a scan); a clear bit is a small dot
 * (still latent). Nothing here is hand-placed — change the input string and the mark
 * changes with it, which is why the derivation is asserted rather than assumed.
 *
 * Run with `node brand/generate.mjs`. Output is byte-for-byte reproducible.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "docs", "public", "brand")
const PUBLIC = join(ROOT, "docs", "public")

const FINGERPRINT_INPUT = "@aburi/core"
const EXPECTED_NIBBLES = "5e72"

/** Mirrors packages/core/src/fingerprint/hash.ts — sha256 of the UTF-8 bytes, first 12 hex chars. */
function fingerprint(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)
}

const nibbles = fingerprint(FINGERPRINT_INPUT).slice(0, 4)
if (nibbles !== EXPECTED_NIBBLES) {
  throw new Error(
    `mark pattern drifted: sha256("${FINGERPRINT_INPUT}") now starts with "${nibbles}", ` +
      `not "${EXPECTED_NIBBLES}". The published mark encodes "${EXPECTED_NIBBLES}" — reconcile ` +
      `deliberately before regenerating.`,
  )
}

/** Cells the fingerprint sets, as [column, row] pairs. Row r is nibble r, MSB leftmost. */
const setCells = []
const clearCells = []
for (let row = 0; row < 4; row++) {
  const value = Number.parseInt(nibbles[row], 16)
  for (let col = 0; col < 4; col++) {
    const bit = (value >> (3 - col)) & 1
    ;(bit ? setCells : clearCells).push([col, row])
  }
}
if (setCells.length !== 9) throw new Error(`expected 9 set bits, got ${setCells.length}`)

const COLOR = {
  sear: "#B87514",
  latentOnLight: "#F2E5D2",
  latentOnDark: "#523409",
  ink: "#14110E",
  paper: "#F2EFE9",
  monoLatentOnLight: "#B8B3AB",
  monoLatentOnDark: "#605B54",
}

/** Full mark: 4x4 at pitch 13 from origin 7 — 11px squares, 5px dots centred in their cell. */
const GRID = { origin: 7, pitch: 13, cell: 11, dot: 5 }
/** Small mark (<= 24px): the grid bleeds to the edges so cells land on whole device pixels. */
const SMALL = { origin: 0, pitch: 16, cell: 12 }

const at = (i, { origin, pitch }) => origin + i * pitch
const dotAt = (i) => at(i, GRID) + (GRID.cell - GRID.dot) / 2

const squares = (cells, grid = GRID) =>
  cells.map(([col, row]) => ({
    x: at(col, grid),
    y: at(row, grid),
    w: grid.cell,
    h: grid.cell,
  }))

const dots = (cells) =>
  cells.map(([col, row]) => ({ x: dotAt(col), y: dotAt(row), w: GRID.dot, h: GRID.dot }))

const rect = ({ x, y, w, h }) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`
const group = (fill, boxes) =>
  boxes.length ? `<g fill="${fill}">${boxes.map(rect).join("")}</g>` : ""

function svg(body, { size = 64, background } = {}) {
  const ground = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Aburi">${ground}${body}</svg>\n`
}

/** Reading order — left to right, top to bottom — so the reveal follows how the grid is read. */
const readingOrder = [...setCells].sort((a, b) => a[1] - b[1] || a[0] - b[0])

function animatedBody() {
  const style = [
    "@keyframes aburi-reveal{0%,3%{transform:scale(.45);opacity:0}12%,74%{transform:scale(1);opacity:1}86%,100%{transform:scale(.45);opacity:0}}",
    ".aburi-cell{transform-box:fill-box;transform-origin:center;animation:aburi-reveal 5s linear infinite;opacity:0}",
    "@media (prefers-reduced-motion:reduce){.aburi-cell{animation:none;opacity:1;transform:none}}",
  ].join("")
  const cells = readingOrder
    .map(([col, row], i) => {
      const box = { x: at(col, GRID), y: at(row, GRID), w: GRID.cell, h: GRID.cell }
      return `<rect class="aburi-cell" style="animation-delay:${(i * 0.08).toFixed(2)}s" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"/>`
    })
    .join("")
  return `<style>${style}</style>${group(COLOR.latentOnLight, dots([...setCells, ...clearCells]))}<g fill="${COLOR.sear}">${cells}</g>`
}

const files = {
  "mark.svg": svg(
    group(COLOR.latentOnLight, dots(clearCells)) + group(COLOR.sear, squares(setCells)),
  ),
  "mark-dark.svg": svg(
    group(COLOR.latentOnDark, dots(clearCells)) + group(COLOR.sear, squares(setCells)),
  ),
  "mark-mono.svg": svg(
    group(COLOR.monoLatentOnLight, dots(clearCells)) + group(COLOR.ink, squares(setCells)),
  ),
  "mark-mono-dark.svg": svg(
    group(COLOR.monoLatentOnDark, dots(clearCells)) + group(COLOR.paper, squares(setCells)),
  ),
  "mark-1bit.svg": svg(group("currentColor", [...dots(clearCells), ...squares(setCells)])),
  "mark-tile.svg": svg(
    group(COLOR.monoLatentOnDark, dots(clearCells)) + group(COLOR.sear, squares(setCells)),
    { background: COLOR.ink },
  ),
  "mark-small.svg": svg(group(COLOR.sear, squares(setCells, SMALL))),
  "mark-animated.svg": svg(animatedBody()),
}

/** --- PNG ------------------------------------------------------------------ */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(width, height, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0 // filter: none
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const rgba = (hex, alpha = 255) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
  alpha,
]

/**
 * Paints axis-aligned boxes given in viewBox units. Every edge in the mark is a
 * multiple of the pitch, so rounding to device pixels never splits a cell.
 */
function paint(width, height, background, boxes, { scale, offsetX = 0, offsetY = 0 }) {
  const pixels = Buffer.alloc(width * height * 4)
  if (background) {
    const [r, g, b, a] = rgba(background)
    for (let i = 0; i < width * height; i++) pixels.set([r, g, b, a], i * 4)
  }
  for (const { x, y, w, h, fill } of boxes) {
    const [r, g, b, a] = rgba(fill)
    const x0 = Math.round(offsetX + x * scale)
    const y0 = Math.round(offsetY + y * scale)
    const x1 = Math.round(offsetX + (x + w) * scale)
    const y1 = Math.round(offsetY + (y + h) * scale)
    for (let py = Math.max(0, y0); py < Math.min(height, y1); py++) {
      for (let px = Math.max(0, x0); px < Math.min(width, x1); px++) {
        pixels.set([r, g, b, a], (py * width + px) * 4)
      }
    }
  }
  return png(width, height, pixels)
}

const withFill = (boxes, fill) => boxes.map((box) => ({ ...box, fill }))

/** Favicons drop the latent dots — below 24px they are smaller than a device pixel. */
const faviconBoxes = withFill(squares(setCells, SMALL), COLOR.sear)
const favicons = Object.fromEntries(
  [16, 32, 48].map((size) => [
    `favicon-${size}.png`,
    paint(size, size, null, faviconBoxes, { scale: size / 64 }),
  ]),
)

/** Apple touch icons are composited on an opaque tile, so the mark keeps its contrast. */
const appleTouch = paint(
  180,
  180,
  COLOR.ink,
  [
    ...withFill(dots(clearCells), COLOR.monoLatentOnDark),
    ...withFill(squares(setCells), COLOR.sear),
  ],
  { scale: (180 * 0.68) / 64, offsetX: 180 * 0.16, offsetY: 180 * 0.16 },
)

/** Social preview: the mark alone on ink. Title and description come from the meta tags. */
const OG = { width: 1200, height: 630, mark: 416 }
const og = paint(
  OG.width,
  OG.height,
  COLOR.ink,
  [
    ...withFill(dots(clearCells), COLOR.monoLatentOnDark),
    ...withFill(squares(setCells), COLOR.sear),
  ],
  {
    scale: OG.mark / 64,
    offsetX: (OG.width - OG.mark) / 2,
    offsetY: (OG.height - OG.mark) / 2,
  },
)

/** --- write ---------------------------------------------------------------- */

mkdirSync(OUT, { recursive: true })
const written = []
for (const [name, contents] of Object.entries(files)) {
  writeFileSync(join(OUT, name), contents)
  written.push(`brand/${name}`)
}
for (const [name, contents] of Object.entries(favicons)) {
  writeFileSync(join(OUT, name), contents)
  written.push(`brand/${name}`)
}
writeFileSync(join(OUT, "apple-touch-icon.png"), appleTouch)
written.push("brand/apple-touch-icon.png")
writeFileSync(join(OUT, "og.png"), og)
written.push("brand/og.png")

/** The site's favicon lives at the root so browsers find it without a hint. */
writeFileSync(join(PUBLIC, "favicon.svg"), files["mark-small.svg"])
written.push("favicon.svg")

console.log(
  `fingerprint ${fingerprint(FINGERPRINT_INPUT)} → pattern ${nibbles} (${setCells.length} cells)`,
)
console.log(`wrote ${written.length} files to docs/public/`)
