import type { IR } from "./generated/ir"

export const IR_SCHEMA_URL = "https://aburi.dev/schema/aburi.ir.v1.json"

export const DIFF_SCHEMA_URL = "https://aburi.dev/schema/aburi.diff.v1.json"

export const CONFIG_SCHEMA_URL = "https://aburi.dev/schema/aburi.config.v1.json"

export const PLUGIN_SCHEMA_URL = "https://aburi.dev/schema/aburi.plugin.v1.json"

/** v1 was served from this host before aburi.dev, and IR documents written then still name it. */
const EARLIER_IR_SCHEMA_URL =
  "https://aburi.kage1020.com/schema/aburi.ir.v1.json" satisfies IR["$schema"]

const IR_SCHEMA_URLS: readonly IR["$schema"][] = [IR_SCHEMA_URL, EARLIER_IR_SCHEMA_URL]

export function isIRSchemaURL(value: unknown): value is IR["$schema"] {
  return IR_SCHEMA_URLS.some((url) => url === value)
}
