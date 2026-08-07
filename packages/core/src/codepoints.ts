/**
 * Render a string alongside its code points, for the errors where the value alone says
 * nothing.
 *
 * Unicode normalization defects are invisible by construction: `é` as one code point and
 * `e` plus a combining acute render identically, so a message that quotes only the offending
 * value shows a string that looks correct next to the claim that it is not — and quoting
 * both spellings side by side shows the same thing twice. The code points are the difference.
 */
export function describeCodePoints(value: string): string {
  const points = [...value]
    .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ")
  return `${JSON.stringify(value)} (${points})`
}
