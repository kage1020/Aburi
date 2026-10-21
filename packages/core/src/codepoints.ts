export function describeCodePoints(value: string): string {
  const points = [...value]
    .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ")
  return `${JSON.stringify(value)} (${points})`
}

/** Unicode NFC, the one form every string in a Document is held in. */
export function toNfc(value: string): string {
  return value.normalize("NFC")
}

const UTF8_BOM = "\uFEFF"

/**
 * PowerShell 5's `Out-File` and `Set-Content` open a file with one under `-Encoding utf8`; Node's
 * `require()`, npm and pnpm read past it.
 */
export function stripUtf8Bom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text
}
