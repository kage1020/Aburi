import { access, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { detectComponents, detectManagers, detectWorkspaceRoot } from "@aburi/core"
import type { Config } from "@aburi/types"
import { CliError } from "../errors"
import { EXIT, type ExitCode } from "../exit-codes"

const CONFIG_SCHEMA_URL = "https://aburi.dev/schema/aburi.config.v1.json"

export interface InitOptions {
  cwd?: string
  output?: string
  force?: boolean
  withSuggestions?: boolean
}

export interface InitReport {
  outputPath: string
  workspaceRoot: string
  detectedManagers: string[]
  detectedLanguages: string[]
  detectedFrameworks: string[]
  componentCount: number
  suggestedPlugins: readonly string[]
  overwrote: boolean
  exitCode: ExitCode
}

/**
 * §4 — `aburi init`. Runs the autodetect chain (workspace root → managers → components),
 * writes an `aburi.json` (or the caller's `--output` path), and returns a structured
 * report so tests can assert on outcome without parsing stdout.
 *
 * Refuses to overwrite an existing file unless `--force` is set; the design (§4.4) uses
 * `exit 2` for that branch, mirrored here through the `InputError` -> `EXIT.INPUT_ERROR`
 * bridge in the caller.
 */
export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoot = await resolveWorkspaceRoot(cwd)
  const outputPath = resolve(cwd, options.output ?? "aburi.json")

  const existed = await pathExists(outputPath)
  if (existed && !options.force) {
    throw new CliError(
      `${outputPath} already exists. Use --force to overwrite or pass --output <path> to write elsewhere.`,
      "input-error",
    )
  }

  const managers = await detectManagers(workspaceRoot)
  const components = await detectComponents({ workspaceRoot })

  const languageSet = new Set<string>()
  for (const c of components) for (const l of c.languages) languageSet.add(l)
  const frameworkSet = new Set<string>()
  for (const c of components) for (const f of c.frameworks ?? []) frameworkSet.add(f)

  const suggestions = options.withSuggestions ? suggestPluginsFor(frameworkSet) : []
  const contents = renderConfig({
    languages: [...languageSet].sort(),
    frameworks: [...frameworkSet].sort(),
    components: components.map((c) => ({
      id: c.id,
      name: c.name,
      roots: [...c.roots].sort(),
      languages: [...c.languages].sort(),
      frameworks: [...(c.frameworks ?? [])].sort(),
    })),
    suggestions,
  })

  await writeFile(outputPath, contents, "utf8")

  return {
    outputPath,
    workspaceRoot,
    detectedManagers: managers.managers.map((m) => m.tool),
    detectedLanguages: [...languageSet].sort(),
    detectedFrameworks: [...frameworkSet].sort(),
    componentCount: components.length,
    suggestedPlugins: suggestions,
    overwrote: existed,
    exitCode: EXIT.SUCCESS,
  }
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    return await detectWorkspaceRoot({ cwd })
  } catch {
    // §4.3: fall back to `cwd` when no marker exists (single-project workspace).
    return resolve(cwd)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * §4.6 tail — suggestion mapping. Kept tiny on purpose; a large plugin catalog belongs
 * outside the CLI so autodetect stays language-agnostic. Only the plugins that ship in
 * this monorepo are hard-coded.
 */
const FRAMEWORK_TO_PLUGIN: ReadonlyMap<string, string> = new Map([
  ["nestjs", "@aburi/framework-nestjs"],
  ["next", "@aburi/framework-next"],
  ["nextjs", "@aburi/framework-next"],
])

function suggestPluginsFor(frameworks: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const f of frameworks) {
    const plugin = FRAMEWORK_TO_PLUGIN.get(f)
    if (plugin !== undefined) out.add(plugin)
  }
  return [...out].sort()
}

interface RenderedConfigInput {
  languages: readonly string[]
  frameworks: readonly string[]
  components: readonly {
    id: string
    name: string
    roots: readonly string[]
    languages: readonly string[]
    frameworks: readonly string[]
  }[]
  suggestions: readonly string[]
}

/**
 * Emits the JSONC form of `aburi.json`. Values that the autodetector could not fill are
 * left as empty arrays instead of `undefined` because the schema uses `[]`-default
 * semantics; comments encode the suggestion list so `--with-suggestions` output stays
 * readable.
 */
function renderConfig(input: RenderedConfigInput): string {
  const config: Partial<Config> & { $schema: string } = {
    $schema: CONFIG_SCHEMA_URL,
    languages: [...input.languages],
    frameworks: [...input.frameworks],
    components: input.components.map((c) => ({
      id: c.id,
      name: c.name,
      roots: [...c.roots],
      languages: [...c.languages],
      frameworks: [...c.frameworks],
    })),
  }
  const json = JSON.stringify(config, null, 2)
  if (input.suggestions.length === 0) return `${json}\n`
  const banner = input.suggestions.map((s) => `// Suggested install: pnpm add -D ${s}`).join("\n")
  // Insert the comment banner right after the opening `{` so the JSON stays valid JSONC.
  const insertion = `\n  ${banner.split("\n").join("\n  ")}`
  return `${json.replace("{\n", `{${insertion}\n`)}\n`
}
