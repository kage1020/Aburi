import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { commitAll, gitTestEnv, initRepository } from "@aburi/test-support"
import { CONFIG_SCHEMA_URL } from "@aburi/types"
import { type AburiRun, runAburi } from "../src"

export async function writeFileAt(root: string, rel: string, content: string): Promise<void> {
  const path = resolve(root, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
}

export const SERVICE = `export class InvoiceService {
  create(total: number) {
    return { total }
  }

  createDraft() {
    return this.create(0)
  }
}
`

export const SERVICE_EDITED = SERVICE.replace("return { total }", "return { total, draft: false }")

/** A repository on `main` holding two pnpm packages, `api` and `web`, one commit in. */
export async function writeRepository(root: string, config: Record<string, unknown> = {}) {
  await writeFileAt(root, "pnpm-workspace.yaml", "packages:\n  - 'pkgs/*'\n")
  await writeFileAt(root, "package.json", JSON.stringify({ name: "root", private: true }))
  await writeFileAt(
    root,
    "aburi.json",
    JSON.stringify({ $schema: CONFIG_SCHEMA_URL, languages: ["lang-typescript"], ...config }),
  )
  await writeFileAt(root, "pkgs/api/package.json", JSON.stringify({ name: "api" }))
  await writeFileAt(root, "pkgs/api/src/invoice.service.ts", SERVICE)
  await writeFileAt(root, "pkgs/web/package.json", JSON.stringify({ name: "web" }))
  await writeFileAt(
    root,
    "pkgs/web/src/page.ts",
    `export function renderInvoice(total: number) {\n  return \`total: \${total}\`\n}\n`,
  )
  await initRepository(root)
  await commitAll(root, "base")
}

/** The CLI run the server's answers are held to. */
export function aburi(root: string, argv: readonly string[]): Promise<AburiRun> {
  return runAburi(argv, { cwd: root, env: gitTestEnv(root) })
}
