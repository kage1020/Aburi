import type { LanguagePlugin } from "@aburi/types"
import { toNfc } from "../codepoints"
import { CoreError } from "../errors"

export function fileExtension(path: string): string | null {
  const dot = path.lastIndexOf(".")
  return dot < 0 ? null : extensionKey(path.slice(dot))
}

function extensionKey(extension: string): string {
  return toNfc(extension.toLowerCase())
}

export function buildLanguageRouter(
  plugins: readonly LanguagePlugin<unknown, unknown>[],
): LanguageRouter {
  const table = new Map<string, LanguagePlugin<unknown, unknown>>()
  for (const plugin of plugins) {
    for (const ext of plugin.fileExtensions) {
      const key = extensionKey(ext)
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

  get knownExtensions(): readonly string[] {
    return [...this.#table.keys()]
  }

  route(path: string): LanguagePlugin<unknown, unknown> | null {
    const extension = fileExtension(path)
    return extension === null ? null : (this.#table.get(extension) ?? null)
  }
}
