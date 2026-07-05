import type { LanguagePlugin } from "@aburi/types"
import { CoreError } from "../errors"

/**
 * Build a case-insensitive extension → LanguagePlugin dispatch table. Each plugin
 * publishes its handled extensions via `fileExtensions` (e.g. `[".ts", ".tsx"]`) and
 * the scan orchestrator uses the map to pick the right parser for each discovered file.
 *
 * A given extension may only be owned by one plugin; a duplicate throws because
 * plugin-registry already enforces manifest uniqueness at load time and reaching here
 * with a collision means something in the caller wiring is inconsistent.
 */
export function buildLanguageRouter(
  plugins: readonly LanguagePlugin<unknown, unknown>[],
): LanguageRouter {
  const table = new Map<string, LanguagePlugin<unknown, unknown>>()
  for (const plugin of plugins) {
    for (const ext of plugin.fileExtensions) {
      const key = ext.toLowerCase()
      const prior = table.get(key)
      if (prior && prior !== plugin) {
        throw new CoreError(
          `Two language plugins claim extension "${ext}": "${prior.manifest.name}" and "${plugin.manifest.name}"`,
          { code: "language-routing-collision", value: ext },
        )
      }
      table.set(key, plugin)
    }
  }
  return new LanguageRouter(table)
}

/**
 * Extension-to-plugin dispatcher. Constructed only via `buildLanguageRouter` so the
 * collision check cannot be bypassed by a direct `new LanguageRouter(...)` call.
 */
export class LanguageRouter {
  readonly #table: ReadonlyMap<string, LanguagePlugin<unknown, unknown>>

  /** @internal — call `buildLanguageRouter` instead. */
  constructor(table: ReadonlyMap<string, LanguagePlugin<unknown, unknown>>) {
    this.#table = table
  }

  /** Every extension a plugin has claimed, lowercased and prefixed with `.`. */
  get knownExtensions(): readonly string[] {
    return [...this.#table.keys()]
  }

  /**
   * Route a file path to its owning plugin. Returns `null` when the extension is not
   * claimed by any plugin — the scan pipeline records those as `skipped.reason ===
   * "unroutable"` rather than guessing a fallback.
   */
  route(path: string): LanguagePlugin<unknown, unknown> | null {
    const dot = path.lastIndexOf(".")
    if (dot < 0) return null
    const ext = path.slice(dot).toLowerCase()
    return this.#table.get(ext) ?? null
  }
}
