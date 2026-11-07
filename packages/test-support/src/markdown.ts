/** The `## ` headings of a Markdown report, in order. */
export function headings(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.startsWith("## "))
}

/** The lines of the `heading` section, from its heading to the next `## ` one. */
export function sectionOf(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n")
  const start = lines.indexOf(heading)
  if (start === -1) throw new Error(`no ${heading} section`)
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "))
  return lines.slice(start, end === -1 ? undefined : end)
}
