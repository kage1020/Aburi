export const DEFAULT_EXTENSIONS: readonly string[] = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mts",
  "cts",
  "mjs",
  "cjs",
]

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  )
}

const EMITTED_EXTENSION_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ["js", ["ts", "tsx", "js", "jsx"]],
  ["jsx", ["tsx", "ts", "jsx", "js"]],
  ["mjs", ["mts", "mjs"]],
  ["cjs", ["cts", "cjs"]],
])

interface ResolveSpecifierInput {
  fromDirectory: string
  specifier: string
  extensions: readonly string[]
  knownFiles: ReadonlySet<string>
}

export function resolveRelativeSpecifier(input: ResolveSpecifierInput): string | null {
  const joined = joinPosix(input.fromDirectory, input.specifier)
  if (joined === null) return null

  const lastSegment = input.specifier.slice(input.specifier.lastIndexOf("/") + 1)
  const namesDirectory = lastSegment === "" || lastSegment === "." || lastSegment === ".."
  if (!namesDirectory) {
    for (const candidate of emittedExtensionSources(joined, input.extensions) ?? [joined]) {
      if (input.knownFiles.has(candidate)) return candidate
    }
    for (const ext of input.extensions) {
      const candidate = `${joined}.${ext}`
      if (input.knownFiles.has(candidate)) return candidate
    }
  }
  const indexStem = joined === "" ? "index" : `${joined}/index`
  for (const ext of input.extensions) {
    const candidate = `${indexStem}.${ext}`
    if (input.knownFiles.has(candidate)) return candidate
  }
  return null
}

function emittedExtensionSources(joined: string, extensions: readonly string[]): string[] | null {
  const dot = joined.lastIndexOf(".")
  if (dot <= joined.lastIndexOf("/") + 1) return null
  const written = joined.slice(dot + 1)
  const sources = EMITTED_EXTENSION_SOURCES.get(written)
  if (sources === undefined) return null
  const stem = joined.slice(0, dot)
  return sources
    .filter((ext) => ext === written || extensions.includes(ext))
    .map((ext) => `${stem}.${ext}`)
}

export function dirname(posixPath: string): string {
  const idx = posixPath.lastIndexOf("/")
  if (idx < 0) return ""
  return posixPath.slice(0, idx)
}

function joinPosix(base: string, specifier: string): string | null {
  const baseSegments = base === "" ? [] : base.split("/")
  const relSegments = specifier.split("/")
  const stack: string[] = [...baseSegments]
  for (const seg of relSegments) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join("/")
}
