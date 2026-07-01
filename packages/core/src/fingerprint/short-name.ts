import { CoreError } from "../errors"

/**
 * Extract the last segment of a qualified name for the api fingerprint's `shortName` field.
 *
 * The api axis is designed so that renaming a containing class (`InvoiceService.create` →
 * `BillingService.create`) does not appear as an api change on the method itself. Keeping
 * only the leaf name reflects that: the class rename shows up at the class Symbol, not on
 * every method.
 *
 * Split precedence: `::` (static receiver) beats `.` (instance receiver). A qname without
 * either separator is returned verbatim.
 *
 * Trailing-separator inputs (`foo::`, `A.`, `::`) would otherwise produce an empty leaf
 * and collapse every broken qname to the same fingerprint. Refuse them at the source
 * instead — a broken qname is a Symbol-id-construction bug upstream, not something to
 * silently absorb here.
 */
export function lastQnameSegment(qname: string): string {
  if (qname.length === 0) {
    throw new CoreError("lastQnameSegment received an empty qualified name", {
      code: "anonymous-symbol-id-attempted",
      value: qname,
    })
  }
  const byColon = qname.split("::")
  const tail = byColon[byColon.length - 1] as string
  const byDot = tail.split(".")
  const leaf = byDot[byDot.length - 1] as string
  if (leaf.length === 0) {
    throw new CoreError(
      `lastQnameSegment received qualified name "${qname}" whose last segment is empty; the upstream Symbol id builder produced an invalid qname`,
      { code: "anonymous-symbol-id-attempted", value: qname },
    )
  }
  return leaf
}
