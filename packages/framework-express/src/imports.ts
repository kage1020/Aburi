import type { FrameworkClassifyContext, ImportEdge, SourceFile } from "@aburi/types"

/**
 * Whether the file reaches Express, which is what separates "definitely Express" (`high`)
 * from "matches the shape" (`medium`). Conservative on purpose: a miss downgrades confidence,
 * not extKind.
 *
 * Read off the file's parsed import edges, so an import is recognised however it is laid out
 * (a named list Prettier wrapped over several lines) and a commented-out one is not. CommonJS
 * `require("express")` produces no import edge, so it alone is read off the source text, with
 * the comments taken out first.
 */
export function hasExpressImport(ctx: FrameworkClassifyContext): boolean {
  return importListMentionsExpress(ctx.imports) || fileRequiresExpress(ctx.file)
}

/**
 * Memoized on the identity of the `SourceFile` the pipeline hands every candidate of a file
 * (`scan/pipeline.ts`). The comment-stripping scan walks the whole file and is asked once per
 * route, middleware and Router, so unmemoized a large CommonJS file would pay registrations ×
 * file length. A fresh `SourceFile` per call simply takes the uncached path.
 */
const requiresExpressByFile = new WeakMap<SourceFile, boolean>()

function fileRequiresExpress(file: SourceFile): boolean {
  const cached = requiresExpressByFile.get(file)
  if (cached !== undefined) return cached
  const answer = requiresExpress(file.content)
  requiresExpressByFile.set(file, answer)
  return answer
}

/** An edge to `express` itself or to one of its subpaths (`express/lib/router`). */
export function importListMentionsExpress(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => edge.source === "express" || edge.source.startsWith("express/"))
}

const REQUIRE_EXPRESS = /\brequire\s*\(\s*['"]express(?:\/[^'"]*)?['"]\s*\)/

/** CommonJS `require("express")` outside a comment. */
export function requiresExpress(content: string): boolean {
  return REQUIRE_EXPRESS.test(withoutComments(content))
}

/**
 * The source with every `//` and block comment replaced by a space. String and template
 * literals are stepped over whole, so a `//` inside `"http://…"` does not start a comment.
 * A regular-expression literal is not recognised: one holding a quote or `//` throws the scan
 * off for the rest of its line, and one holding a backtick or `/*` for the rest of the file.
 * At worst that moves this fallback's answer for a file that also hides a `require`; the
 * import edges, which decide almost every file, are unaffected.
 */
function withoutComments(content: string): string {
  let out = ""
  let i = 0
  while (i < content.length) {
    const char = content[i]
    const next = content[i + 1]
    if (char === "/" && next === "/") {
      const end = content.indexOf("\n", i)
      i = end === -1 ? content.length : end
      out += " "
      continue
    }
    if (char === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2)
      i = end === -1 ? content.length : end + 2
      out += " "
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      const end = literalEnd(content, i, char)
      out += content.slice(i, end)
      i = end
      continue
    }
    out += char
    i += 1
  }
  return out
}

/** The index just past the literal opened by `quote` at `start`, honouring backslash escapes. */
function literalEnd(content: string, start: number, quote: string): number {
  let i = start + 1
  while (i < content.length) {
    const char = content[i]
    if (char === "\\") {
      i += 2
      continue
    }
    if (char === quote) return i + 1
    // A quote string cannot run past the end of its line; a template literal can.
    if (char === "\n" && quote !== "`") return i
    i += 1
  }
  return content.length
}
