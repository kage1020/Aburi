import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, runScan } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig, writeMonorepo } from "./workspace"

const workspace = useScratchWorkspace("config-discovery")

/** The monorepo of `writeMonorepo`, plus a source file only the root holds. */
async function monorepo(): Promise<string> {
  const app = await writeMonorepo(workspace.root)
  await workspace.writeSource("src/root-only.ts", "export function root() { return 0 }\n")
  return app
}

function scanFrom(cwd: string, configPath?: string) {
  return runScan({
    cwd,
    outputDir: resolve(cwd, "out"),
    format: "json",
    ...(configPath === undefined ? {} : { configPath }),
  })
}

describe("aburi scan — which config it reads", () => {
  it.each([
    ["a package-local config, when run from that package", ["app"], "app"],
    ["an ancestor's config when the package has none", ["root"], "root"],
    ["the nearest config over an ancestor's", ["root", "app"], "app"],
  ])("reads %s", async (_, written, read) => {
    const app = await monorepo()
    const directories: Record<string, string> = { root: workspace.root, app }
    for (const where of written) await writeConfig(directories[where] ?? "", TYPESCRIPT)

    const report = await scanFrom(app)

    expect(report.configSource).toBe(resolve(directories[read] ?? "", "aburi.json"))
  })

  it("resolves a relative --config against the directory it ran in", async () => {
    const app = await monorepo()
    await writeConfig(app, TYPESCRIPT, "custom.json")

    const report = await scanFrom(app, "./custom.json")

    expect(report.configSource).toBe(resolve(app, "custom.json"))
  })

  it("names the path it tried for a relative --config that names nothing", async () => {
    const app = await monorepo()

    const error = await errorFrom(CliError, () => scanFrom(app, "./missing.json"))

    expect(error.message).toContain(resolve(app, "missing.json"))
  })
})

describe("aburi scan — a config below the workspace root", () => {
  it("scans the whole workspace, not just the package the config sits in", async () => {
    const app = await monorepo()
    await writeConfig(app, TYPESCRIPT)

    const report = await scanFrom(app)

    expect(report.workspaceRoot).toBe(workspace.root)
    expect(report.keptSymbols).toBe(2)
    expect(report.skipped).toEqual([])
  })

  it("resolves the config's `ignore` globs against the workspace root, not the package", async () => {
    const app = await monorepo()
    await writeConfig(app, { ...TYPESCRIPT, ignore: ["src/**"] })

    const report = await scanFrom(app)

    expect(report.keptSymbols).toBe(1)
  })

  it("warns on stderr, naming both, when the config sits below the root", async () => {
    const app = await monorepo()
    await writeConfig(app, TYPESCRIPT)

    const { stderr } = await runCliIn(app, ["scan", "--format", "json"])

    expect(stderr).toContain(
      `Config ${resolve(app, "aburi.json")} sits below the workspace root ${workspace.root}.`,
    )
  })

  it("stays quiet when the config sits at the root", async () => {
    const app = await monorepo()
    await writeConfig(workspace.root, TYPESCRIPT)

    const { stderr } = await runCliIn(app, ["scan", "--format", "json"])

    expect(stderr).not.toContain("sits below the workspace root")
  })
})
