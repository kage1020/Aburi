/**
 * Detector vocabulary → plugin manifest name. The detectors speak `LanguageId` /
 * framework ids (`ts`, `tsx`, `nestjs`); the top-level `languages` / `frameworks` fields
 * of `aburi.json` are `PluginRef`s that the plugin loader resolves as module specifiers.
 * Writing a detector id into those fields is refused by the loader, which names the plugin
 * this table maps it to.
 *
 * Kept tiny on purpose; a large plugin catalog belongs outside the CLI so autodetect
 * stays language-agnostic. Only the plugins that ship in this monorepo are listed, and a
 * detected id with no entry is omitted rather than guessed at — an unresolvable ref would
 * fail the very next `aburi scan`.
 */
export const LANGUAGE_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["ts", "lang-typescript"],
  ["tsx", "lang-typescript"],
  ["js", "lang-typescript"],
  ["jsx", "lang-typescript"],
])

export const FRAMEWORK_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["nestjs", "framework-nestjs"],
  // `nextjs`, not `next`: the npm dependency `next` is normalised to the framework id
  // `nextjs` by the detector, and this table's left column is the detector's vocabulary.
  ["nextjs", "framework-next"],
  ["react", "framework-react"],
  ["express", "framework-express"],
])

/**
 * The plugin `aburi init` would write for a detector id found in `field`, so a config that
 * holds the id itself can be told what to write instead.
 */
export function pluginForDetectorId(
  field: "languages" | "frameworks",
  id: string,
): string | undefined {
  return (field === "languages" ? LANGUAGE_TO_PLUGIN : FRAMEWORK_TO_PLUGIN).get(id)
}

/** The framework id a first-party framework plugin's manifest name stands for. */
export function frameworkIdForPlugin(name: string): string | undefined {
  for (const [id, plugin] of FRAMEWORK_TO_PLUGIN) if (plugin === name) return id
  return undefined
}
