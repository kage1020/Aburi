import { CoreError } from "../errors"

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
