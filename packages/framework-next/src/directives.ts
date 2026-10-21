import { stripUtf8Bom } from "@aburi/core"

export type ModuleDirective = "client" | "server"

export function detectModuleDirective(source: string): ModuleDirective | null {
  // The parser skips a leading byte order mark, and a directive behind one is still the module's
  // first statement.
  let remainder = stripUtf8Bom(source)
  while (true) {
    const trimmed = skipLeadingCommentsAndWhitespace(remainder)
    if (trimmed === null) return null
    const readStatement = readStringLiteralStatement(trimmed)
    if (readStatement === null) return null
    if (readStatement.body === "use client") return "client"
    if (readStatement.body === "use server") return "server"
    remainder = readStatement.rest
  }
}

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
  body: string
  rest: string
}

function readStringLiteralStatement(input: string): StringLiteralStatement | null {
  const first = input[0]
  if (first !== '"' && first !== "'") return null
  const quote = first
  const end = input.indexOf(quote, 1)
  if (end < 0) return null

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
