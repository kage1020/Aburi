import MarkdownIt from "markdown-it"

export function bytes(markdown: string): number {
  return Buffer.byteLength(markdown, "utf8")
}

export function headings(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.startsWith("## "))
}

export function noteOf(markdown: string): string {
  return markdown.split("\n").find((line) => line.startsWith("> ⚠")) ?? ""
}

export function sectionOf(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n")
  const start = lines.indexOf(heading)
  if (start === -1) throw new Error(`no ${heading} section`)
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "))
  return lines.slice(start, end === -1 ? undefined : end)
}

const commonMark = new MarkdownIt({ html: true })

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"' }

/** The text a reader sees. Raw HTML is on, as on GitHub, so a tag inside a value drops out of it. */
export function shownText(markdown: string): string {
  return commonMark
    .render(markdown)
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot);/g, (_, name: string) => ENTITIES[name] ?? "")
}
