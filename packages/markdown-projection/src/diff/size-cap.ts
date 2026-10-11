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
  entryCount: number,
): Section | null {
  if (body.length === 0) return null
  return {
    title: titleOf(heading),
    lines: [
      heading,
      "",
      "<details>",
      `<summary>${entryCount} entries</summary>`,
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

/** Sizes are the whole document's, note included: naming a section there costs bytes too. */
export function arrangeWithin(
  sections: readonly Section[],
  size: (arrangement: Arrangement) => number,
  maxBytes: number,
): Arrangement {
  const rows = sections.map((section): { section: Section; shown: Shown } => ({
    section,
    shown: OMITTED,
  }))
  const place = (row: { section: Section; shown: Shown }): void => {
    let best: { shown: Shown; bytes: number } | null = null
    for (const shown of formsOf(row.section)) {
      row.shown = shown
      const bytes = size(rows)
      if (bytes > maxBytes || (best !== null && bytes >= best.bytes)) continue
      if (keepsOrder(rows, size)) best = { shown, bytes }
    }
    row.shown = best?.shown ?? OMITTED
  }
  const wholeFromTop = (): boolean => {
    let changed = false
    for (const row of rows) {
      const shown = row.shown
      if (shown.kind !== "short") continue
      row.shown = FULL
      if (size(rows) > maxBytes) {
        row.shown = shown
        break
      }
      changed = true
    }
    return changed
  }

  for (const row of rows) place(row)
  // A list made whole leaves the note and can free room for a section omitted earlier. Sections
  // only move from omitted to shown and from names-only to whole, so the loop ends.
  for (let changed = true; changed; ) {
    changed = wholeFromTop()
    for (const row of rows) {
      if (row.shown.kind !== "omitted") continue
      place(row)
      if (row.shown.kind !== "omitted") changed = true
    }
  }
  return rows
}

/** Whole first, so that a tie keeps the section whole. */
function formsOf(section: Section): Shown[] {
  return section.short === undefined ? [FULL] : [FULL, { kind: "short", lines: section.short }]
}

/** A list stays whole below a names-only one only where names-only would not be smaller. */
function keepsOrder(
  rows: Array<{ section: Section; shown: Shown }>,
  size: (arrangement: Arrangement) => number,
): boolean {
  const bytes = size(rows)
  let shortAbove = false
  for (const row of rows) {
    const { section, shown } = row
    if (section.short === undefined) continue
    if (shown.kind === "short") shortAbove = true
    if (shown.kind !== "full" || !shortAbove) continue
    row.shown = { kind: "short", lines: section.short }
    const smaller = size(rows) < bytes
    row.shown = shown
    if (smaller) return false
  }
  return true
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
