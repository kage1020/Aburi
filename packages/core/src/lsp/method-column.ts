export function findMethodColumn(
  line: string,
  masked: string,
  head: string,
  method: string,
): number | null {
  const needle = new RegExp(
    `${NO_NAME_BEFORE}${escapeRegExp(head)}\\??\\.${escapeRegExp(method)}${NO_NAME_AFTER}`,
    "gu",
  )
  const match = masked.matchAll(needle).next().value ?? soleMatch(line, needle)
  if (match === undefined) return null
  return match.index + match[0].length - method.length
}

const NO_NAME_BEFORE = String.raw`(?<![\p{ID_Continue}$\u{200C}\u{200D}])(?<!(?<!\.\.)\.)`
const NO_NAME_AFTER = String.raw`(?![\p{ID_Continue}$\u{200C}\u{200D}])`

function soleMatch(text: string, pattern: RegExp): RegExpExecArray | undefined {
  const [only, ...rest] = text.matchAll(pattern)
  return rest.length === 0 ? only : undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function maskStringsAndComments(line: string): string {
  const out = line.split("")
  maskCode(line, 0, out, false)
  return out.join("")
}

function maskCode(line: string, start: number, out: string[], inInterpolation: boolean): number {
  let depth = 0
  let i = start
  while (i < line.length) {
    const char = line[i]
    const next = line[i + 1]
    if (char === "/" && next === "/") {
      blank(out, i, line.length)
      return line.length
    }
    if (char === "/" && next === "*") {
      const close = line.indexOf("*/", i + 2)
      const end = close === -1 ? line.length : close + 2
      blank(out, i, end)
      i = end
      continue
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(line, i, char)
      blank(out, i, end)
      i = end
      continue
    }
    if (char === "`") {
      i = maskTemplate(line, i, out)
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      if (inInterpolation && depth === 0) return i
      depth -= 1
    }
    i += 1
  }
  return line.length
}

function maskTemplate(line: string, start: number, out: string[]): number {
  blank(out, start, start + 1)
  let i = start + 1
  while (i < line.length) {
    const char = line[i]
    if (char === "`") {
      blank(out, i, i + 1)
      return i + 1
    }
    if (char === "$" && line[i + 1] === "{") {
      i = maskCode(line, i + 2, out, true) + 1
      continue
    }
    const end = Math.min(char === "\\" ? i + 2 : i + 1, line.length)
    blank(out, i, end)
    i = end
  }
  return line.length
}

function quotedEnd(line: string, start: number, quote: string): number {
  let i = start + 1
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2
      continue
    }
    if (line[i] === quote) return i + 1
    i += 1
  }
  return line.length
}

function blank(out: string[], from: number, to: number): void {
  for (let k = from; k < to; k += 1) out[k] = " "
}
