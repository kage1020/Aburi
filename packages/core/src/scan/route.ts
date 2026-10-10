import type { LanguagePlugin } from "@aburi/types"
import { CoreError } from "../errors"

export function fileExtension(path: string): string | null {
  const dot = path.lastIndexOf(".")
  return dot < 0 ? null : path.slice(dot).toLowerCase()
}

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

  route(path: string): LanguagePlugin<unknown, unknown> | null {
    const extension = fileExtension(path)
    return extension === null ? null : (this.#table.get(extension) ?? null)
  }
}
