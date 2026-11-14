import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import {
  commitAll,
  editFile,
  gitTestEnv,
  initRepository,
  type ScratchWorkspace,
} from "@aburi/test-support"
import { CONFIG_SCHEMA_URL } from "@aburi/types"
import { type AburiRun, runAburi } from "../src"

export const SERVICE_PATH = "pkgs/api/src/invoice.service.ts"

const SERVICE = `export class InvoiceService {
  create(total: number) {
    return { total }
  }

  createDraft() {
    return this.create(0)
  }
}
`

/** A repository on `main` holding two pnpm packages, `api` and `web`, one commit in. */
export async function writeRepository(
  workspace: ScratchWorkspace,
  config: Record<string, unknown> = {},
): Promise<void> {
  await workspace.writeSource("pnpm-workspace.yaml", "packages:\n  - 'pkgs/*'\n")
  await workspace.writeSource("package.json", JSON.stringify({ name: "root", private: true }))
  await workspace.writeSource(
    "aburi.json",
    JSON.stringify({ $schema: CONFIG_SCHEMA_URL, languages: ["lang-typescript"], ...config }),
  )
  await workspace.writeSource("pkgs/api/package.json", JSON.stringify({ name: "api" }))
  await workspace.writeSource(SERVICE_PATH, SERVICE)
  await workspace.writeSource("pkgs/web/package.json", JSON.stringify({ name: "web" }))
  await workspace.writeSource(
    "pkgs/web/src/page.ts",
    `export function renderInvoice(total: number) {\n  return \`total: \${total}\`\n}\n`,
  )
  await initRepository(workspace.root)
  await commitAll(workspace.root, "base")
}

/** The edit the diffs here report: `InvoiceService.create` returns one more field. */
export function editService(root: string): Promise<void> {
  return editFile(join(root, SERVICE_PATH), "return { total }", "return { total, draft: false }")
}

/** Installs `source` as the `aburi` bin of an `@aburi/cli` in the workspace's node_modules. */
export async function installWorkspaceCli(
  workspace: ScratchWorkspace,
  source: string,
): Promise<string> {
  await workspace.writeSource(
    "node_modules/@aburi/cli/package.json",
    JSON.stringify({ name: "@aburi/cli", bin: { aburi: "./bin.mjs" } }),
  )
  await workspace.writeSource("node_modules/@aburi/cli/bin.mjs", source)
  return join(workspace.root, "node_modules/@aburi/cli/bin.mjs")
}

/** The bin of the `@aburi/cli` this package depends on. */
export const BUNDLED_BIN: string = (() => {
  const manifest = createRequire(import.meta.url).resolve("@aburi/cli/package.json")
  const { bin } = createRequire(import.meta.url)(manifest) as { bin: { aburi: string } }
  return resolve(dirname(manifest), bin.aburi)
})()

/** The CLI run the server's answers are held to. */
export function aburi(root: string, argv: readonly string[]): Promise<AburiRun> {
  return runAburi(argv, { cwd: root, env: gitTestEnv(root) })
}

/** Where a run wrote: the value of its `--output-dir`. */
export function outputOf(run: { readonly argv: readonly string[] }): string {
  const at = run.argv.indexOf("--output-dir")
  const output = run.argv[at + 1]
  if (at === -1 || output === undefined) {
    throw new Error(`${run.argv.join(" ")} names no --output-dir`)
  }
  return output
}

// Loads forever and holds SIGTERM, as a plugin stuck in a native call can. Its pid is written on
// the main thread, where the CLI's own signal handling lives; with `deaf`, it also takes that away,
// as a CLI killed outright on Windows never gets to run it.
export function hangingPlugin({ deaf = false }: { deaf?: boolean } = {}): string {
  return `import { writeFileSync } from "node:fs"
import { isMainThread } from "node:worker_threads"
if (isMainThread) {
  ${deaf ? 'process.removeAllListeners("SIGTERM")' : ""}
  process.on("SIGTERM", () => {})
  writeFileSync(new URL("./hanging.pid", import.meta.url), String(process.pid))
}
setInterval(() => {}, 1_000)
await new Promise(() => {})
`
}
