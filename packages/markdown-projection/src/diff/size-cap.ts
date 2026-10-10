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
  const fits = (arrangement: Arrangement): boolean =>
    Buffer.byteLength(render(arrangement, false), "utf8") <= maxBytes

  const whole = sections.map((section) => ({ section, shown: FULL }))
  if (fits(whole)) return render(whole, false)
  const arrangement = arrangeWithin(sections, fits)
  if (fits(arrangement)) return render(arrangement, false)
  return render(
    sections.map((section) => ({ section, shown: OMITTED })),
    true,
  )
}

export function arrangeWithin(
  sections: readonly Section[],
  fits: (arrangement: Arrangement) => boolean,
): Arrangement {
  const rows = sections.map((section): { section: Section; shown: Shown } => ({
    section,
    shown: OMITTED,
  }))
  for (const row of rows) {
    row.shown = row.section.short === undefined ? FULL : { kind: "short", lines: row.section.short }
    if (!fits(rows)) row.shown = OMITTED
  }
  for (const row of rows) {
    const shown = row.shown
    if (shown.kind !== "short") continue
    row.shown = FULL
    if (!fits(rows)) {
      row.shown = shown
      break
    }
  }
  return rows
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
