import { toNfc } from "../codepoints"

export function normalizeFingerprintString(input: string): string {
  return toNfc(input).replace(/\s+/g, " ").trim()
}
