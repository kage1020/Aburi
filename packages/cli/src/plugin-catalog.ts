export const LANGUAGE_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["ts", "lang-typescript"],
  ["tsx", "lang-typescript"],
  ["js", "lang-typescript"],
  ["jsx", "lang-typescript"],
])

export const FRAMEWORK_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["nestjs", "framework-nestjs"],
  ["nextjs", "framework-next"],
  ["react", "framework-react"],
  ["express", "framework-express"],
])

export function pluginForDetectorId(
  field: "languages" | "frameworks",
  id: string,
): string | undefined {
  return (field === "languages" ? LANGUAGE_TO_PLUGIN : FRAMEWORK_TO_PLUGIN).get(id)
}

export function frameworkIdForPlugin(name: string): string | undefined {
  for (const [id, plugin] of FRAMEWORK_TO_PLUGIN) if (plugin === name) return id
  return undefined
}
