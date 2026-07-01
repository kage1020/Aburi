/**
 * Extract the last segment of a qualified name for the api fingerprint's `shortName` field.
 *
 * The api axis is designed so that renaming a containing class (`InvoiceService.create` →
 * `BillingService.create`) does not appear as an api change on the method itself. Keeping
 * only the leaf name reflects that: the class rename shows up at the class Symbol, not on
 * every method.
 *
 * Split precedence: `::` (static receiver) beats `.` (instance receiver). A qname without
 * either separator, and the reserved `<default>` sentinel, are returned verbatim.
 */
export function lastQnameSegment(qname: string): string {
  const byColon = qname.split("::")
  const tail = byColon[byColon.length - 1] ?? qname
  const byDot = tail.split(".")
  return byDot[byDot.length - 1] ?? tail
}
