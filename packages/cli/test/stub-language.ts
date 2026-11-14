import { rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { makeLanguageId } from "@aburi/core"
import { commitAll, initRepository, NO_LANGUAGE_CAPABILITIES } from "@aburi/test-support"
import type { PluginManifest } from "@aburi/types"
import { LANG_MANIFEST, pluginModuleSource } from "./plugin-fakes"
import { writeConfig, writeFileAt, writePackageJson } from "./workspace"

/**
 * A language plugin for `.stub` files whose name decides what happens to them: `bad` fails to
 * parse, `notree` parses to nothing, `noisy` and `warn` parse with recoverable errors, `boom`
 * throws in extraction, `odd` emits an undeclared extKind and `twin` two Symbols with one id.
 */
export const STUB_PLUGIN: string = stubPluginSource({
  ...LANG_MANIFEST,
  name: "lang-stub",
  languageId: makeLanguageId("stub"),
  // It holds no WASM memory, and the least a plugin may declare lets free memory start as many
  // parser workers as a test asks for.
  capabilities: { wasmHeapPerWorkerMB: 16 },
})

/** The stub language, except that on a parser worker it runs `end` on a file named `crash`. */
export function workerEndingPlugin(end: string): string {
  return stubPluginRunning({
    parse: `    const { isMainThread } = await import("node:worker_threads")
    if (!isMainThread && file.path.includes("crash")) {
${end}
    }`,
  })
}

/**
 * The stub language, running `init` in its `init(ctx)`, `cleanup` in its `cleanup()`, and `parse`
 * as its `parseFile(file)` starts.
 */
export function stubPluginRunning(code: {
  init?: string
  cleanup?: string
  parse?: string
}): string {
  return STUB_PLUGIN.replace(
    "  init: async () => {},\n",
    `  init: async (ctx) => {
${code.init ?? ""}
  },
  cleanup: async () => {
${code.cleanup ?? ""}
  },
`,
  ).replace(
    "  parseFile: async (file) => {\n",
    `  parseFile: async (file) => {
${code.parse ?? ""}
`,
  )
}

/** The stub plugin's module source under another `manifest`, with `members` ahead of its own. */
export function stubPluginSource(manifest: PluginManifest, members = ""): string {
  return pluginModuleSource(
    manifest,
    `${members}  fileExtensions: [".stub"],
  capabilities: ${JSON.stringify(NO_LANGUAGE_CAPABILITIES)},
  init: async () => {},
  parseFile: async (file) => {
    const tree = { path: file.path }
    if (file.path.includes("notree")) return { tree: null, errors: [], imports: [] }
    if (file.path.includes("bad")) {
      return {
        tree,
        errors: [{ message: "unterminated string", line: 12, column: 4, recoverable: false }],
        imports: [],
      }
    }
    if (file.path.includes("noisy")) {
      return {
        tree,
        errors: [
          { message: "stray token", line: 2, column: 1, recoverable: true },
          { message: "stray token", line: 9, column: 7, recoverable: true },
        ],
        imports: [],
      }
    }
    if (file.path.includes("warn")) {
      return {
        tree,
        errors: [{ message: "stray token", line: 2, column: 1, recoverable: true }],
        imports: [],
      }
    }
    return { tree, errors: [], imports: [] }
  },
  extractSymbols: (tree, ctx) => {
    if (ctx.file.path.includes("boom")) throw new Error("plugin exploded")
    const name = ctx.file.path.replace(/[^A-Za-z0-9]/g, "_")
    const at = (startLine) => ({
      id: "stub:" + ctx.file.path + "#" + name,
      kind: "function",
      extKind: ctx.file.path.includes("odd") ? "stub:odd:thing" : null,
      name,
      visibility: "public",
      decorators: [],
      signature: null,
      source: {
        file: ctx.file.path,
        startLine,
        endLine: startLine + 1,
        startColumn: null,
        endColumn: null,
      },
      derivedBy: [],
      bodyNode: tree,
      fullNode: tree,
    })
    return ctx.file.path.includes("twin") ? [at(1), at(7)] : [at(1)]
  },
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "stub-ast",`,
  )
}

/** A workspace configured with only the stub plugin, holding `files`, each containing its own name. */
export async function writeStubWorkspace(
  directory: string,
  files: readonly string[],
  config: Record<string, unknown> = {},
): Promise<void> {
  await writePackageJson(directory, { name: "stub-fixture", private: true })
  await writeConfig(directory, { languages: ["./lang-stub.mjs"], ...config })
  await writeFileAt(directory, "lang-stub.mjs", STUB_PLUGIN)
  for (const file of files) await writeFileAt(directory, file, file)
}

/** A repository on `main` whose one commit holds `base`, with the working tree changed to `head`. */
export async function writeStubRepository(
  directory: string,
  files: { base: readonly string[]; head: readonly string[] },
  config: Record<string, unknown> = {},
): Promise<void> {
  await writeStubWorkspace(directory, files.base, config)
  await initRepository(directory)
  await commitAll(directory, "base")
  for (const file of files.base) {
    if (!files.head.includes(file)) await rm(resolve(directory, file))
  }
  for (const file of files.head) await writeFile(resolve(directory, file), file, "utf8")
}
