import type { LanguageId } from "@aburi/types"
import { glob } from "tinyglobby"
import { toNfc } from "./codepoints"
import type { DetectComponentsOptions } from "./component"
import { makeLanguageId } from "./id"
import { compareCodeUnit } from "./order"
import { CORE_IGNORE_PATTERNS } from "./scan/discover"
import { openGitignoreTree } from "./scan/gitignore"
import { fileExtension } from "./scan/route"

const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
  [".py", "py"],
  [".go", "go"],
  [".rs", "rs"],
  [".java", "java"],
  [".kt", "kt"],
  [".kts", "kt"],
  [".scala", "scala"],
  [".rb", "rb"],
  [".php", "php"],
  [".cs", "cs"],
  [".swift", "swift"],
  [".ex", "ex"],
  [".exs", "ex"],
])

const LANGUAGE_SCAN_DEPTH = 3

const LANGUAGE_MIN_FILES = 10

const LANGUAGE_MIN_SHARE = 0.05

export async function countLanguagesPerRoot(
  workspaceRoot: string,
  roots: readonly string[],
  options: Pick<DetectComponentsOptions, "ignore" | "respectGitignore">,
): Promise<Map<string, LanguageId[]>> {
  const files = await glob(["**/*"], {
    cwd: workspaceRoot,
    ignore: [...CORE_IGNORE_PATTERNS, ...(options.ignore ?? [])],
    onlyFiles: true,
    dot: false,
    deep: Math.max(...roots.map((root) => rootDepth(root) + LANGUAGE_SCAN_DEPTH)),
  })
  const gitignore = (options.respectGitignore ?? true) ? openGitignoreTree(workspaceRoot) : null

  const counts = new Map<string, Map<LanguageId, number>>(roots.map((root) => [root, new Map()]))
  for (const file of files) {
    const language = languageOfExtension(file)
    if (language === null) continue
    if (gitignore !== null && (await gitignore.ignores(file))) continue
    const normalized = toNfc(file)
    for (const root of roots) {
      if (!withinRoot(root, normalized)) continue
      const perRoot = counts.get(root)
      if (perRoot !== undefined) perRoot.set(language, (perRoot.get(language) ?? 0) + 1)
    }
  }
  return new Map([...counts].map(([root, perRoot]) => [root, frequentLanguages(perRoot)]))
}

function rootDepth(root: string): number {
  return root === "." ? 0 : root.split("/").length
}

function withinRoot(root: string, file: string): boolean {
  if (root === ".") return directoryLevels(file) <= LANGUAGE_SCAN_DEPTH
  if (!file.startsWith(`${root}/`)) return false
  return directoryLevels(file.slice(root.length + 1)) <= LANGUAGE_SCAN_DEPTH
}

function directoryLevels(file: string): number {
  return file.split("/").length - 1
}

function languageOfExtension(file: string): LanguageId | null {
  const extension = fileExtension(file)
  const raw = extension === null ? undefined : EXTENSION_TO_LANGUAGE.get(extension)
  if (raw === undefined) return null
  return makeLanguageId(raw)
}

function frequentLanguages(counts: ReadonlyMap<LanguageId, number>): LanguageId[] {
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const out: LanguageId[] = []
  for (const [lang, count] of counts) {
    if (count < LANGUAGE_MIN_FILES) continue
    if (count / total < LANGUAGE_MIN_SHARE) continue
    out.push(lang)
  }
  return out.sort(compareCodeUnit)
}
