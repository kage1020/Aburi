import MarkdownIt from "markdown-it"

export function bytes(markdown: string): number {
  return Buffer.byteLength(markdown, "utf8")
}

export function noteOf(markdown: string): string {
  return markdown.split("\n").find((line) => line.startsWith("> ⚠")) ?? ""
}

/** `html: true`, as GitHub drops an unknown tag like `<T>`; escaped, it would decode back and hide that loss. */
const commonMark = new MarkdownIt({ html: true })

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"' }

/** markdown-it strikes through on `~~` only, where GitHub also takes a single `~`. */
export function shownText(markdown: string): string {
  return commonMark
    .render(markdown)
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot);/g, (_, name: string) => ENTITIES[name] ?? "")
}
