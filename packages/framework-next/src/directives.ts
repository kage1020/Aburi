export type ModuleDirective = "client" | "server"

/** Some editors prepend a BOM to UTF-8 sources; the parser skips it. */
const UTF8_BOM = "﻿"

/**
 * The `"use client"` / `"use server"` directive in the module's directive prologue, or
 * `null`. The prologue may hold several directives (`'use strict'; 'use client';`), so every
 * leading string-literal statement is consumed. A cheap text scan rather than an AST walk,
 * since this runs once per Symbol.
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

function stripUtf8Bom(source: string): string {
  return source.startsWith(UTF8_BOM) ? source.slice(UTF8_BOM.length) : source
}

/** The input from its first non-comment, non-whitespace character, or `null` if there is none. */
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
 * Read one bare string-literal statement from the start of the input, or `null`. Only `'`
 * and `"` qualify: the spec excludes template literals from directives, and escapes are not
 * handled because Next.js directives never use them.
 */
function readStringLiteralStatement(input: string): StringLiteralStatement | null {
  const first = input[0]
  if (first !== '"' && first !== "'") return null
  const quote = first
  const end = input.indexOf(quote, 1)
  if (end < 0) return null

  // Only horizontal whitespace is skipped: a newline terminates the statement (ASI), and
  // consuming it would let a `+` on the next line read as a continuation.
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
