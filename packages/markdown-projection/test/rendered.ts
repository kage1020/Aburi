import MarkdownIt, { type Token } from "markdown-it"

/** `html: true`, as GitHub drops an unknown tag like `<T>`; escaped, it would decode back and hide that loss. */
export const commonMark = new MarkdownIt({ html: true })

/** What a reader sees of one run of inline Markdown, and what each code span in it holds. */
export interface Inline {
  readonly text: string
  readonly code: readonly string[]
}

export type Block =
  | { readonly kind: "heading"; readonly level: number; readonly inline: Inline }
  | { readonly kind: "paragraph"; readonly inline: Inline }
  | { readonly kind: "list"; readonly items: readonly (readonly Block[])[] }
  | { readonly kind: "code"; readonly content: string }
  | {
      readonly kind: "table"
      readonly head: readonly Inline[]
      readonly rows: readonly (readonly Inline[])[]
    }
  | { readonly kind: "quote"; readonly blocks: readonly Block[] }
  | { readonly kind: "html"; readonly content: string }
  | { readonly kind: "rule" }

/**
 * The block tree a CommonMark + GFM-table renderer builds from `markdown`. markdown-it stands in for
 * GitHub's cmark-gfm: it answers what the spec says, not what GitHub draws.
 */
export function rendered(markdown: string): Block[] {
  const reader = new TokenReader(commonMark.parse(markdown, {}))
  const blocks = reader.blocksUntil(null)
  reader.expectEnd()
  return blocks
}

/** `markdown` read as the inline content of a paragraph or a table cell. */
export function renderedInline(markdown: string): Inline {
  const [token] = commonMark.parseInline(markdown, {})
  if (token === undefined) throw new Error("parseInline returned no token")
  return inlineOf(token)
}

/** The first table, list, … in reading order, descending into lists and quotes. */
export function first<K extends Block["kind"]>(
  blocks: readonly Block[],
  kind: K,
): Extract<Block, { kind: K }> {
  const found = everyBlock(blocks).find(
    (block): block is Extract<Block, { kind: K }> => block.kind === kind,
  )
  if (found === undefined) throw new Error(`no ${kind} in the rendered document`)
  return found
}

function everyBlock(blocks: readonly Block[]): Block[] {
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case "list":
        return [block, ...block.items.flatMap((item) => everyBlock(item))]
      case "quote":
        return [block, ...everyBlock(block.blocks)]
      default:
        return [block]
    }
  })
}

/**
 * The blocks after the paragraph whose last line reads `label`, up to the next paragraph or heading.
 * Labels on consecutive lines, as `**File**:` and `**Rules**:` are in diff.md, share one paragraph.
 */
export function blocksUnder(blocks: readonly Block[], label: string): Block[] {
  const start = blocks.findIndex(
    (block) => block.kind === "paragraph" && block.inline.text.split("\n").at(-1) === label,
  )
  if (start === -1) throw new Error(`no paragraph reading ${JSON.stringify(label)}`)
  const rest = blocks.slice(start + 1)
  const end = rest.findIndex((block) => block.kind === "paragraph" || block.kind === "heading")
  return end === -1 ? rest : rest.slice(0, end)
}

class TokenReader {
  private at = 0

  constructor(private readonly tokens: readonly Token[]) {}

  blocksUntil(close: string | null): Block[] {
    const blocks: Block[] = []
    for (;;) {
      const token = this.tokens[this.at]
      if (token === undefined) {
        if (close === null) return blocks
        throw new Error(`the token stream ended before ${close}`)
      }
      if (token.type === close) {
        this.at++
        return blocks
      }
      blocks.push(this.block())
    }
  }

  expectEnd(): void {
    if (this.at !== this.tokens.length) throw new Error(`unread token at ${this.at}`)
  }

  private block(): Block {
    const token = this.take()
    switch (token.type) {
      case "heading_open": {
        const inline = this.inline()
        this.take("heading_close")
        return { kind: "heading", level: Number(token.tag.slice(1)), inline }
      }
      case "paragraph_open": {
        const inline = this.inline()
        this.take("paragraph_close")
        return { kind: "paragraph", inline }
      }
      case "bullet_list_open":
      case "ordered_list_open":
        return { kind: "list", items: this.listItems(token.type.replace("_open", "_close")) }
      case "fence":
      case "code_block":
        return { kind: "code", content: token.content }
      case "table_open":
        return this.table()
      case "blockquote_open":
        return { kind: "quote", blocks: this.blocksUntil("blockquote_close") }
      case "html_block":
        return { kind: "html", content: token.content }
      case "hr":
        return { kind: "rule" }
      default:
        throw new Error(`no block reads a ${token.type} token`)
    }
  }

  private listItems(close: string): Block[][] {
    const items: Block[][] = []
    while (this.peek() !== close) {
      this.take("list_item_open")
      items.push(this.blocksUntil("list_item_close"))
    }
    this.take(close)
    return items
  }

  private table(): Block {
    const rows: Inline[][] = []
    while (this.peek() !== "table_close") {
      const token = this.take()
      if (token.type === "tr_open") rows.push([])
      if (token.type === "inline") rows.at(-1)?.push(inlineOf(token))
    }
    this.take("table_close")
    const [head, ...body] = rows
    if (head === undefined) throw new Error("a table with no header row")
    return { kind: "table", head, rows: body }
  }

  private inline(): Inline {
    return inlineOf(this.take("inline"))
  }

  private peek(): string | undefined {
    return this.tokens[this.at]?.type
  }

  private take(type?: string): Token {
    const token = this.tokens[this.at]
    if (token === undefined) throw new Error(`the token stream ended before ${type ?? "a block"}`)
    if (type !== undefined && token.type !== type) {
      throw new Error(`expected ${type} at token ${this.at}, read ${token.type}`)
    }
    this.at++
    return token
  }
}

function inlineOf(token: Token): Inline {
  let text = ""
  const code: string[] = []
  for (const child of token.children ?? []) {
    switch (child.type) {
      case "text":
        text += child.content
        break
      case "code_inline":
        text += child.content
        code.push(child.content)
        break
      case "softbreak":
      case "hardbreak":
        text += "\n"
        break
      case "html_inline":
        // GitHub draws `<br>` as a break and drops a tag it does not know, such as `<T>`.
        if (/^<br\s*\/?>$/i.test(child.content)) text += "\n"
        break
      default:
        break
    }
  }
  return { text, code }
}
