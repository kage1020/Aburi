import type { FrameworkClassifyContext, ImportEdge } from "@aburi/types"
import { isOther, type SourceToken, tokenize } from "./source-tokens"

export function hasExpressImport(ctx: FrameworkClassifyContext): boolean {
  if (importListMentionsExpress(ctx.imports)) return true
  const text = expressInTextOf(ctx)
  return text.requires || text.imports
}

export function importListMentionsExpress(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => isExpressSpecifier(edge.source))
}

/** What a file's source text says about `express`, read by `readExpressFromText`. */
export interface ExpressInText {
  /** A `require("express")` call: `require`, `(`, the specifier, `)`. */
  requires: boolean
  imports: boolean
}

export function readExpressFromText(content: string): ExpressInText {
  const tokens = tokenize(content)
  let requires = false
  let imports = false
  // The `import` / `export` keyword whose specifier has not been reached yet.
  let statement = -1
  for (let i = 0; i < tokens.length && !(requires && imports); i++) {
    const token = tokens[i] as SourceToken
    if (token.kind === "word") {
      if ((token.text === "import" || token.text === "export") && !isOther(tokens[i - 1], ".")) {
        statement = i
      } else if (
        token.text === "require" &&
        isOther(tokens[i + 1], "(") &&
        isExpressString(tokens[i + 2]) &&
        isOther(tokens[i + 3], ")")
      ) {
        requires = true
      }
      continue
    }
    if (token.kind === "string") {
      const before = tokens[i - 1]
      const isSpecifier =
        i === statement + 1 ||
        (i === statement + 2 && isOther(before, "(")) ||
        (before?.kind === "word" && before.text === "from")
      if (statement !== -1 && isSpecifier && isExpressString(token)) imports = true
      statement = -1
      continue
    }
    if (token.text === ";") statement = -1
  }
  return { requires, imports }
}

function isExpressString(token: SourceToken | undefined): boolean {
  return token?.kind === "string" && isExpressSpecifier(token.text)
}

function isExpressSpecifier(source: string): boolean {
  return source === "express" || source.startsWith("express/")
}

const textByImports = new WeakMap<
  readonly ImportEdge[],
  { content: string; found: ExpressInText }
>()

function expressInTextOf(ctx: FrameworkClassifyContext): ExpressInText {
  const { content } = ctx.file
  const cached = textByImports.get(ctx.imports)
  if (cached !== undefined && cached.content === content) return cached.found
  const found = readExpressFromText(content)
  textByImports.set(ctx.imports, { content, found })
  return found
}
