import type { PluginManifest, Provides } from "@aburi/types"
import { raise } from "./errors"

const PROVIDES_ENTRIES = {
  effects: ["id", "description"],
  effectPrefixes: "string",
  extKinds: ["id", "baseKind", "description"],
  extKindPrefixes: "string",
  frameworks: "string",
  derivedByPrefixes: "string",
} as const satisfies Record<keyof Provides, readonly string[] | "string">

function describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** Refuses a manifest typed `PluginManifest` whose name, provides arrays or entries are not. */
export function assertProvidesShape(m: PluginManifest): void {
  if (typeof m.name !== "string") {
    raise(
      `Plugin manifest name must be a string (got ${describeType(m.name)}).`,
      "manifest-invalid",
      [],
    )
  }
  if (!m.provides || typeof m.provides !== "object") {
    raise(`Plugin "${m.name}" is missing the required \`provides\` object.`, "manifest-invalid", [
      m.name,
    ])
  }
  // Annotated rather than inferred, so a call narrows the way a call to `raise` does.
  const refuse: (at: string, expected: string, value: unknown) => never = (at, expected, value) =>
    raise(
      `Plugin "${m.name}" provides.${at} must be ${expected} (got ${describeType(value)}).`,
      "manifest-invalid",
      [m.name],
    )
  const provides = m.provides as unknown as Record<string, unknown>
  for (const [key, fields] of Object.entries(PROVIDES_ENTRIES)) {
    // Own keys only, as for `type`: an inherited array would walk past this gate.
    const value = Object.hasOwn(provides, key) ? provides[key] : undefined
    if (!Array.isArray(value)) refuse(key, "an array", value)
    for (const [i, entry] of (value as unknown[]).entries()) {
      if (fields === "string") {
        if (typeof entry !== "string") refuse(`${key}[${i}]`, "a string", entry)
        continue
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        refuse(`${key}[${i}]`, "an object", entry)
      }
      for (const field of fields) {
        const own = Object.hasOwn(entry, field)
          ? (entry as Record<string, unknown>)[field]
          : undefined
        if (typeof own !== "string") refuse(`${key}[${i}].${field}`, "a string", own)
      }
    }
  }
}
