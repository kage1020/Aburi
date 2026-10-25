import { renderDocument } from "../format"

export interface Section {
  readonly title: string
  readonly lines: readonly string[]
  readonly short?: readonly string[]
}

export type Shown =
  | { readonly kind: "full" }
  | { readonly kind: "short"; readonly lines: readonly string[] }
  | { readonly kind: "omitted" }

export type Arrangement = ReadonlyArray<{ readonly section: Section; readonly shown: Shown }>

const FULL: Shown = { kind: "full" }
const OMITTED: Shown = { kind: "omitted" }

const NAMES_ONLY_LINE =
  "_Names and locations only: the full entries did not fit within the size cap._"

export function plainSection(
  heading: string,
  body: readonly string[],
  namesOnly?: readonly string[],
): Section | null {
  if (body.length === 0) return null
  const lines = [heading, "", ...body, ""]
  const short =
    namesOnly === undefined ? undefined : [heading, "", NAMES_ONLY_LINE, "", ...namesOnly, ""]
  return {
    title: titleOf(heading),
    lines,
    ...(short === undefined || byteLength(short) >= byteLength(lines) ? {} : { short }),
  }
}

export function foldedSection(
  heading: string,
  body: readonly string[],
  summary: string,
): Section | null {
  if (body.length === 0) return null
  return {
    title: titleOf(heading),
    lines: [
      heading,
      "",
      "<details>",
      `<summary>${summary}</summary>`,
      "",
      ...body,
      "",
      "</details>",
      "",
    ],
  }
}

function titleOf(heading: string): string {
  return heading.replace(/^#+ */, "")
}

function byteLength(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join("\n"), "utf8")
}

export function assemble(
  heading: readonly string[],
  sections: readonly Section[],
  maxBytes: number | undefined,
  fullReportLocation: string | undefined,
): string {
  if (maxBytes === undefined) {
    return renderDocument([...heading, ...sections.flatMap((section) => [...section.lines])])
  }

  const render = (arrangement: Arrangement, unachievable: boolean): string =>
    renderDocument([
      ...heading,
      ...omissionNote(arrangement, maxBytes, unachievable, fullReportLocation),
      ...arrangement.flatMap(({ section, shown }) => linesIn(section, shown)),
    ])
  const size = (arrangement: Arrangement): number =>
    Buffer.byteLength(render(arrangement, false), "utf8")

  const whole = sections.map((section) => ({ section, shown: FULL }))
  if (size(whole) <= maxBytes) return render(whole, false)
  const arrangement = arrangeWithin(sections, size, maxBytes)
  if (size(arrangement) <= maxBytes) return render(arrangement, false)
  return render(
    sections.map((section) => ({ section, shown: OMITTED })),
    true,
  )
}

type Row = { readonly section: Section; shown: Shown }

/** Sizes are the whole document's, note included: naming a section there costs bytes too. */
export function arrangeWithin(
  sections: readonly Section[],
  size: (arrangement: Arrangement) => number,
  maxBytes: number,
): Arrangement {
  const rows = sections.map((section): Row => ({ section, shown: OMITTED }))
  const formsShown = (): Shown[] => rows.map(({ shown }) => shown)
  const showAs = (forms: readonly Shown[]): void => {
    for (const [index, row] of rows.entries()) row.shown = forms[index] ?? OMITTED
  }
  const place = (row: Row, index: number): void => {
    const before = formsShown()
    let best: { forms: Shown[]; bytes: number } | null = null
    for (const shown of formsOf(row.section)) {
      row.shown = shown
      const bytes = size(rows)
      if (best === null || bytes < best.bytes) {
        const ordered = orderBelow(rows, index, size, bytes)
        if (ordered !== null && ordered <= maxBytes) {
          best = { forms: formsShown(), bytes }
        }
      }
      showAs(before)
    }
    showAs(best?.forms ?? before)
  }
  const wholeFromTop = (): void => {
    for (const row of rows) {
      const shown = row.shown
      if (shown.kind !== "short") continue
      row.shown = FULL
      if (size(rows) > maxBytes) {
        row.shown = shown
        return
      }
    }
  }

  for (const [index, row] of rows.entries()) place(row, index)
  // A section placed or made whole later leaves the note, which can free room for one omitted
  // earlier. A section once shown is never omitted again, so the loop ends.
  for (let putBack = true; putBack; ) {
    wholeFromTop()
    putBack = false
    for (const [index, row] of rows.entries()) {
      if (row.shown.kind !== "omitted") continue
      place(row, index)
      if (row.shown.kind !== "omitted") putBack = true
    }
  }
  return rows
}

/** Whole first, so that a tie keeps the section whole. */
function formsOf(section: Section): Shown[] {
  return section.short === undefined ? [FULL] : [FULL, { kind: "short", lines: section.short }]
}

/** A less important list gives way rather than cost the section at `index` its place. */
function orderBelow(
  rows: readonly Row[],
  index: number,
  size: (arrangement: Arrangement) => number,
  bytes: number,
): number | null {
  let current = bytes
  for (;;) {
    const next = firstOutOfOrder(rows, size, current)
    if (next === null) return current
    if (next.index <= index) return null
    next.row.shown = next.short
    current = next.bytes
  }
}

/** On a tie a list stays whole below a names-only one: whole shows more for the same bytes. */
function firstOutOfOrder(
  rows: readonly Row[],
  size: (arrangement: Arrangement) => number,
  bytes: number,
): { index: number; row: Row; short: Shown; bytes: number } | null {
  let shortAbove = false
  for (const [index, row] of rows.entries()) {
    const { section, shown } = row
    if (section.short === undefined) continue
    if (shown.kind === "short") shortAbove = true
    if (shown.kind !== "full" || !shortAbove) continue
    const short: Shown = { kind: "short", lines: section.short }
    row.shown = short
    const shorter = size(rows)
    row.shown = shown
    if (shorter < bytes) return { index, row, short, bytes: shorter }
  }
  return null
}

function linesIn(section: Section, shown: Shown): readonly string[] {
  switch (shown.kind) {
    case "full":
      return section.lines
    case "short":
      return shown.lines
    case "omitted":
      return []
  }
}

function omissionNote(
  arrangement: Arrangement,
  maxBytes: number,
  unachievable: boolean,
  fullReportLocation: string | undefined,
): string[] {
  const titlesShown = (kind: Shown["kind"]) =>
    arrangement.filter(({ shown }) => shown.kind === kind).map(({ section }) => section.title)
  const shortened = titlesShown("short")
  const omitted = titlesShown("omitted")
  if (shortened.length === 0 && omitted.length === 0) {
    return unachievable
      ? [`> ⚠ This report could not be brought within ${maxBytes} bytes.`, ""]
      : []
  }
  const budget = unachievable
    ? `and this report still could not be brought within ${maxBytes} bytes`
    : `to keep this report within ${maxBytes} bytes`
  const shortClaim = `**${countSections(shortened.length)} names only**`
  const omittedClaim = `**${countSections(omitted.length, true)} omitted**`
  const pointer =
    fullReportLocation === undefined
      ? "The full report is the same diff rendered without a size cap."
      : `The full report, the same diff without a size cap, is ${fullReportLocation}.`
  if (omitted.length === 0) {
    return [`> ⚠ ${shortClaim} ${budget}: ${shortened.join(", ")}. ${pointer}`, ""]
  }
  if (shortened.length === 0) {
    return [`> ⚠ ${omittedClaim} ${budget}: ${omitted.join(", ")}. ${pointer}`, ""]
  }
  return [
    `> ⚠ ${shortClaim} and ${omittedClaim} ${budget}. ` +
      `Names only: ${shortened.join(", ")}. Omitted: ${omitted.join(", ")}. ${pointer}`,
    "",
  ]
}

function countSections(count: number, passive = false): string {
  if (passive) return count === 1 ? "1 section was" : `${count} sections were`
  return count === 1 ? "1 section lists" : `${count} sections list`
}
