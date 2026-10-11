import { RegistryError } from "./errors"

/** Key-sorted JSON, so two manifests compare equal exactly when their contents do. */
export function stableStringify(value: unknown, path = "$"): string {
  if (value === null) return "null"
  const t = typeof value
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value)
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
    throw new RegistryError(
      `Plugin manifest contains a non-JSON value (${t}) at ${path}; only plain JSON ` +
        `(string/number/boolean/null, plain object, array) is supported.`,
      { code: "manifest-invalid", plugins: [] },
    )
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => stableStringify(v, `${path}[${i}]`)).join(",")}]`
  }
  const proto = Object.getPrototypeOf(value as object)
  if (proto !== Object.prototype && proto !== null) {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown"
    throw new RegistryError(
      `Plugin manifest contains a non-plain object (${ctor}) at ${path}; only plain JSON ` +
        `objects are supported.`,
      { code: "manifest-invalid", plugins: [] },
    )
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], `${path}.${k}`)}`)
  return `{${entries.join(",")}}`
}
