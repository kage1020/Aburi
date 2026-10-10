import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("unresolved-declarations")

async function writeSources(directory: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await workspace.writeSource(`${directory}/f${index}.ts`, "export const x = 1\n")
  }
}

async function scan(config: Record<string, unknown> = {}): Promise<string> {
  await writeConfig(workspace.root, { ...TYPESCRIPT, ...config })
  return (await runCliIn(workspace.root, ["scan"])).stderr
}

const DEAD_PACKAGES = 'packages:\n  - "packages/*"\n'
const FELL_BACK = "the whole repository is described as one component"

describe("aburi scan — a manifest whose package patterns named no package", () => {
  it("names the tool and the pattern, and that the repository became one component", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", DEAD_PACKAGES)
    await mkdir(resolve(workspace.root, "packages", "dist"), { recursive: true })
    await writeSources("src")

    const stderr = await scan()

    expect(stderr).toContain(
      'pnpm-workspace.yaml declares 1 pnpm package pattern that named no package: "packages/*"',
    )
    expect(stderr).toContain("leave the field out if the workspace has no packages yet")
    expect(stderr).toContain(FELL_BACK)
  })

  it("stops naming patterns before the line stops being readable", async () => {
    const patterns = Array.from({ length: 12 }, (_, index) => `  - "dead${index}/*"`)
    await workspace.writeSource("pnpm-workspace.yaml", `packages:\n${patterns.join("\n")}\n`)
    await writeSources("src")

    const stderr = await scan()

    expect(stderr).toContain('"dead9/*", and 2 more')
    expect(stderr).not.toContain("dead10")
  })

  it("says nothing about a manifest that named no packages to begin with", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", "onlyBuiltDependencies: []\n")
    await writeSources("src")

    const stderr = await scan()

    expect(stderr).not.toContain("named no package")
    expect(stderr).not.toContain("whole repository")
  })

  it("leaves out the consequence when the config decides the components", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", DEAD_PACKAGES)
    await writeSources("src")

    const stderr = await scan({ components: [{ id: "app", roots: ["src"], languages: ["ts"] }] })

    expect(stderr).toContain("pnpm-workspace.yaml declares 1 pnpm package pattern")
    expect(stderr).not.toContain("whole repository")
  })

  it("leaves out the consequence when another manager found packages", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", 'packages:\n  - "tools/*"\n')
    await writePackageJson(workspace.root, { name: "root", workspaces: ["apps/*"] })
    await writePackageJson(resolve(workspace.root, "apps/a"), { name: "a" })
    await writeSources("apps/a/src")

    const stderr = await scan()

    expect(stderr).toContain("pnpm-workspace.yaml declares 1 pnpm package pattern")
    expect(stderr).not.toContain("whole repository")
  })
})

describe("aburi init — a manifest whose package patterns named no package", () => {
  it("names the tool, the patterns and the consequence", async () => {
    await workspace.writeSource(
      "pnpm-workspace.yaml",
      'packages:\n  - "packages/*"\n  - "tools/*"\n',
    )
    await writeSources("src")

    const { code, stderr } = await runCliIn(workspace.root, ["init"])

    expect(code).toBe(EXIT.SUCCESS)
    expect(stderr).toContain(
      'pnpm-workspace.yaml declares 2 pnpm package patterns that named no package: "packages/*", "tools/*"',
    )
    expect(stderr).toContain(FELL_BACK)
  })

  it("says nothing when the packages resolve", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", DEAD_PACKAGES)
    await writePackageJson(resolve(workspace.root, "packages/app"), { name: "app" })
    await writeSources("packages/app/src")

    const { stderr } = await runCliIn(workspace.root, ["init"])

    expect(stderr).not.toContain("named no package")
  })
})
