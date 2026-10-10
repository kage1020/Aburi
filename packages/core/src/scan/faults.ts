/** The `code` a coded error carries, or `null` for a thrown value that has none. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

export function isVanishedFile(error: unknown): boolean {
  const code = errorCode(error)
  return code === "ENOENT" || code === "ENOTDIR"
}

export function describeThrown(error: unknown): string {
  const described = describeValue(error)
  return described.length > 0 ? described : `a thrown ${typeof error} described itself as empty`
}

function describeValue(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : safeString(error)
  if (typeof error !== "object" || error === null) return safeString(error)
  try {
    return JSON.stringify(error) ?? safeString(error)
  } catch {
    return safeString(error)
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export function describeJsonType(value: unknown): string {
  if (Array.isArray(value)) return "a list"
  if (value === null) return "null"
  const type = typeof value
  return `${type === "object" ? "an" : "a"} ${type}`
}
