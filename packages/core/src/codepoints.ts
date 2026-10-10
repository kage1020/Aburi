export function describeCodePoints(value: string): string {
  const points = [...value]
    .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ")
  return `${JSON.stringify(value)} (${points})`
}

/** Unicode NFC, the one form every string in a Document is held in (ir-schema.md). */
export function toNfc(value: string): string {
  return value.normalize("NFC")
}
