export type ModuleDirective = "client" | "server"

/**
 * Detect the top-of-module `"use client"` / `"use server"` directive.
 *
 * ECMAScript treats a string-literal expression statement at the very top of the module
 * as a directive when it precedes every non-comment token. Next.js relies on this exact
 * shape — anything else (comments interleaved between directives, directives inside
 * conditional blocks, string concatenation) is not honored as a directive by the
 * runtime, and we mirror that here.
 *
 * The check is intentionally cheap and does not require an AST: this classifier gets
 * called once per Symbol and per-Symbol tokenization would be wasteful, especially since
 * the module-level directive is a file-level property and applies to every Symbol in the
 * file uniformly. Callers can cache the result if they want to amortize further.
 *
 * Returns the directive kind (`"client"` or `"server"`) when the first directive
 * position matches one of them, or `null` when the file has no such directive.
 */
export function detectModuleDirective(source: string): ModuleDirective | null {
  const trimmed = skipLeadingCommentsAndWhitespace(source)
  if (trimmed === null) return null

  // Directive prologues are one or more string-literal expression statements. The first
  // one that is neither "use client" nor "use server" ends the prologue for our purposes
  // — Next.js only respects the two directives above, and the caller only needs to know
  // whether either is present at the head of the module.
  const directive = readStringLiteralStatement(trimmed)
  if (directive === null) return null
  if (directive === "use client") return "client"
  if (directive === "use server") return "server"
  return null
}

/**
 * Skip leading whitespace and both comment styles (line comments and block comments —
 * the block variant consumes greedily to the closing marker so nested `*` characters
 * inside the body do not confuse the walker).
 *
 * Returns the substring starting at the first non-comment, non-whitespace character, or
 * `null` when the entire input is comments / whitespace.
 */
function skipLeadingCommentsAndWhitespace(source: string): string | null {
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index++
      continue
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2)
      index = newline < 0 ? source.length : newline + 1
      continue
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    return source.slice(index)
  }
  return null
}

/**
 * Read a single string-literal expression statement from the beginning of the input.
 * Returns the literal's contents (unquoted) or `null` when the input does not start with
 * a bare string statement.
 *
 * Only single quotes and double quotes are recognized — template literals cannot be used
 * for directives per the ECMAScript spec, and directives cannot use escape sequences
 * per Next.js's convention (though the spec technically permits them). Keeping the
 * parser narrow avoids false-positive matches on backticks or complex escapes.
 */
function readStringLiteralStatement(input: string): string | null {
  const first = input[0]
  if (first !== '"' && first !== "'") return null
  const quote = first
  const end = input.indexOf(quote, 1)
  if (end < 0) return null

  // Skip horizontal whitespace only (space / tab) — a newline ends the statement via
  // ASI so it counts as a terminator, but consuming it here would let a `+` on the next
  // line masquerade as a legitimate follow-up token. What actually terminates a bare
  // directive statement is one of: end-of-input, semicolon, newline (`\r` / `\n`), or
  // the start of a comment.
  let i = end + 1
  while (i < input.length && (input[i] === " " || input[i] === "\t")) i++

  if (i >= input.length) return input.slice(1, end)
  const nextChar = input[i]
  if (nextChar === ";" || nextChar === "\r" || nextChar === "\n") return input.slice(1, end)
  const twoChars = input.slice(i, i + 2)
  if (twoChars === "//" || twoChars === "/*") return input.slice(1, end)
  return null
}
