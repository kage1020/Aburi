import type { FrameworkClassifyContext, ImportEdge } from "@aburi/types"
import { isOther, type SourceToken, tokenize } from "./source-tokens"

/**
 * Whether the file reaches Express, which is what separates "definitely Express" (`high`)
 * from "matches the shape" (`medium`). Conservative on purpose: a miss downgrades confidence,
 * not extKind.
 *
 * Read first off the file's parsed import edges, so an import is recognised whatever line
 * breaks it is written with (a named list a formatter wrapped over several lines) and a
 * commented-out one is not. `import express = require("express")` is an edge too.
 *
 * When no edge names `express`, the source text is read, with comments skipped and literals
 * stepped over (`readExpressFromText`), for two things the edges cannot say. One is the
 * assignment form `const express = require("express")`, which produces no edge. The other is
 * an import the edges miss although it is written: one the parser lost to error recovery
 * (merge-conflict markers around it, junk tokens after it), or one inside a
 * `declare module` or `namespace` block, since the edges are read off the module's top level
 * only. Either way the file says it imports `express`, and the text reading is what keeps a
 * file mid-edit from reading `medium` when nobody touched its import.
 */
export function hasExpressImport(ctx: FrameworkClassifyContext): boolean {
  if (importListMentionsExpress(ctx.imports)) return true
  const text = expressInTextOf(ctx)
  return text.requires || text.imports
}

/**
 * An edge to `express` itself or to one of its subpaths (`express/lib/router`). For a caller
 * that holds a file's import edges without a classify context; classification asks
 * `hasExpressImport`, which also reads the text.
 */
export function importListMentionsExpress(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => isExpressSpecifier(edge.source))
}

/** What a file's source text says about `express`, read by `readExpressFromText`. */
export interface ExpressInText {
  /** A `require("express")` call: `require`, `(`, the specifier, `)`. */
  requires: boolean
  /**
   * An `import` or `export … from` statement whose specifier is `express`: `from "express"`,
   * a side-effect `import "express"`, or a dynamic `import("express")`.
   */
  imports: boolean
}

/**
 * Read `content` for a `require` or an import of `express` or one of its subpaths, as tokens
 * (`tokenize`): a comment is skipped, so a commented-out import does not count, and a string,
 * template or regular-expression literal is one token, so code quoted inside one does not
 * count either. The specifier may be written in either quote or in backticks with no
 * substitution, as a dynamic `import()` may. What the tokenizer cannot read, JSX text, it
 * cannot read here either; see `tokenize`.
 */
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
      // The first string after the keyword is the specifier, when it is written where one goes:
      // `import "x"`, `import("x")`, or after `from`.
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

/**
 * The text reading, cached per file: `classifySymbol` asks `hasExpressImport` up to once per
 * candidate, and each module-level `x.get(…)`, `x.use(…)`, `x.listen(…)` or `x.set(…)` is
 * one, so uncached a large CommonJS file would be tokenized once per such call. Keyed on the
 * `imports` array, the per-file identity `lang-plugin.md` §4.5 lets a plugin memoize on
 * (framework-nestjs keys its import index on it too). The content an entry was read from is
 * stored with it and compared on every hit, so a context built some other way can cost a
 * fresh read but never an answer read from another file's text.
 */
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
