export type ModuleDirective = "client" | "server"

/** Unicode Byte Order Mark. Some editors add it to UTF-8 sources; the parser transparently skips it. */
const UTF8_BOM = "﻿"

/**
 * Detect the top-of-module `"use client"` / `"use server"` directive.
 *
 * ECMAScript treats a string-literal expression statement at the very top of the module
 * as a directive when it precedes every non-comment token. A directive prologue can
 * carry more than one directive (`'use strict'; 'use client';`); the runtime honors the
 * first `"use client"` / `"use server"` regardless of its position within that prologue,
 * so the scanner walks every string-literal statement it can consume and returns as soon
 * as it hits one it recognizes.
 *
 * The check is intentionally cheap and does not require an AST: this classifier gets
 * called once per Symbol and per-Symbol tokenization would be wasteful, especially since
 * the module-level directive is a file-level property and applies to every Symbol in the
 * file uniformly. Callers can cache the result if they want to amortize further.
 *
 * Returns the directive kind (`"client"` or `"server"`) when the prologue contains one,
 * or `null` when the prologue ends without matching either.
 */
export function detectModuleDirective(source: string): ModuleDirective | null {
  let remainder = stripUtf8Bom(source)
  while (true) {
    const trimmed = skipLeadingCommentsAndWhitespace(remainder)
    if (trimmed === null) return null
    const readStatement = readStringLiteralStatement(trimmed)
    if (readStatement === null) return null
    if (readStatement.body === "use client") return "client"
    if (readStatement.body === "use server") return "server"
    // Any other bare string literal (`'use strict'`, third-party directives) belongs to
    // the prologue too; keep consuming until we hit a non-string statement or run out.
    remainder = readStatement.rest
  }
}

/** Skip a leading UTF-8 BOM if present. The BOM is invisible in most editors but sits in the file bytes. */
function stripUtf8Bom(source: string): string {
  return source.startsWith(UTF8_BOM) ? source.slice(UTF8_BOM.length) : source
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

interface StringLiteralStatement {
  /** The unquoted body of the string literal (`"use client"` → `use client`). */
  body: string
  /** Everything left in the source after the statement's terminator. */
  rest: string
}

/**
 * Read a single string-literal expression statement from the beginning of the input.
 * Returns the literal's contents plus the remainder of the source, or `null` when the
 * input does not start with a bare string statement.
 *
 * Only single quotes and double quotes are recognized — template literals cannot be
 * used for directives per the ECMAScript spec, and directives cannot use escape
 * sequences per Next.js's convention (though the spec technically permits them).
 * Keeping the parser narrow avoids false-positive matches on backticks or complex
 * escapes.
 */
function readStringLiteralStatement(input: string): StringLiteralStatement | null {
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

  const body = input.slice(1, end)
  if (i >= input.length) return { body, rest: "" }
  const nextChar = input[i]
  if (nextChar === ";") return { body, rest: input.slice(i + 1) }
  if (nextChar === "\r" || nextChar === "\n") return { body, rest: input.slice(i) }
  const twoChars = input.slice(i, i + 2)
  if (twoChars === "//" || twoChars === "/*") return { body, rest: input.slice(i) }
  return null
}
