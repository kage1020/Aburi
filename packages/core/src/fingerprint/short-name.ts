import { lastSegment } from "@aburi/types"
import { CoreError } from "../errors"

export function lastQnameSegment(qname: string): string {
  if (qname.length === 0) {
    throw new CoreError("lastQnameSegment received an empty qualified name", {
      code: "anonymous-symbol-id-attempted",
      value: qname,
    })
  }
  const leaf = lastSegment(qname)
  if (leaf.length === 0) {
    throw new CoreError(
      `lastQnameSegment received qualified name "${qname}" whose last segment is empty; the upstream Symbol id builder produced an invalid qname`,
      { code: "anonymous-symbol-id-attempted", value: qname },
    )
  }
  return leaf
}
