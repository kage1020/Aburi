import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli } from "../src/run"

/**
 * A `packages:` list that named no package reaches the same single-project fallback as a
 * manifest that named none, and only the second wants it. The IR keeps no trace either way
 * that a reader can act on — `workspace.managers[].roots` is empty, which is also what a
 * turbo co-marker writes on purpose — so stderr is the whole of the account.
 */

let workRoot = ""

beforeEach(async () => {
  workRoot = await mkdtemp(resolve(tmpdir(), "aburi-unresolved-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function write(relativePath: string, body: string): Promise<void> {
  const path = resolve(workRoot, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, "utf8")
}

/** Enough files of one extension to clear the census thresholds and give the scan something. */
async function writeSource(directory: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await write(`${directory}/f${index}.ts`, "export const x = 1\n")
  }
}

interface Streams {
  exitCode: number
  stderr: string
}

async function run(...argv: string[]): Promise<Streams> {
  let stderr = ""
  const sink = (target: { text: string }) =>
    ({
      write(chunk: string): boolean {
        target.text += chunk
        return true
      },
    }) as unknown as NodeJS.WritableStream
  const errBuffer = { text: "" }
  const exitCode = await runCli({
    argv,
    cwd: workRoot,
    stdout: sink({ text: "" }),
    stderr: sink(errBuffer),
  })
  stderr = errBuffer.text
  return { exitCode, stderr }
}

async function writeConfig(extra: Record<string, unknown> = {}): Promise<void> {
  await write(
    "aburi.json",
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      ...extra,
    }),
  )
}

describe("aburi scan says which manifest named no package", () => {
  it("names the tool and the patterns, and what followed from it", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    await mkdir(resolve(workRoot, "packages", "dist"), { recursive: true })
    await writeSource("src")
    await writeConfig()

    const { stderr } = await run("scan")

    expect(stderr).toContain(
      'pnpm-workspace.yaml declares 1 pnpm package pattern that named no package: "packages/*"',
    )
    expect(stderr).toContain("leave the field out if the workspace has no packages yet")
    expect(stderr).toContain("the whole repository is described as one component")
  })

  it("stops naming patterns before the line stops being readable", async () => {
    // The manifest still holds every one of them, and the line names the manifest — so the
    // rest is a file away, which is what the skip census truncates for too.
    const patterns = Array.from({ length: 12 }, (_, index) => `dead${index}/*`)
    await write(
      "pnpm-workspace.yaml",
      `packages:\n${patterns.map((p) => `  - "${p}"`).join("\n")}\n`,
    )
    await writeSource("src")
    await writeConfig()

    const { stderr } = await run("scan")

    expect(stderr).toContain('"dead9/*", and 2 more')
    expect(stderr).not.toContain("dead10")
  })

  it("says nothing about a manifest that named no packages to begin with", async () => {
    await write("pnpm-workspace.yaml", "onlyBuiltDependencies: []\n")
    await writeSource("src")
    await writeConfig()

    const { stderr } = await run("scan")

    expect(stderr).not.toContain("named no package")
    expect(stderr).not.toContain("whole repository")
  })

  it("leaves out the consequence when the config decides the components", async () => {
    // The manifest is still ineffective — `workspace.managers[]` records it with no roots —
    // but detection's answer never reached the IR, so the second line would describe a
    // Document that was built the other way.
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    await writeSource("src")
    await writeConfig({ components: [{ id: "app", roots: ["src"], languages: ["ts"] }] })

    const { stderr } = await run("scan")

    expect(stderr).toContain("pnpm-workspace.yaml declares 1 pnpm package pattern")
    expect(stderr).not.toContain("whole repository")
  })

  it("leaves out the consequence when another manager found packages", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "tools/*"\n')
    await write("package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] }))
    await write("apps/a/package.json", JSON.stringify({ name: "a" }))
    await writeSource("apps/a/src")
    await writeConfig()

    const { stderr } = await run("scan")

    expect(stderr).toContain("pnpm-workspace.yaml declares 1 pnpm package pattern")
    expect(stderr).not.toContain("whole repository")
  })
})

describe("aburi init says the same", () => {
  it("names the tool, the patterns and the consequence", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "tools/*"\n')
    await writeSource("src")

    const { exitCode, stderr } = await run("init")

    expect(exitCode).toBe(0)
    expect(stderr).toContain(
      "pnpm-workspace.yaml declares 2 pnpm package patterns that named no package: " +
        '"packages/*", "tools/*"',
    )
    expect(stderr).toContain("the whole repository is described as one component")
  })

  it("says nothing when the packages resolve", async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    await write("packages/app/package.json", JSON.stringify({ name: "app" }))
    await writeSource("packages/app/src")

    const { stderr } = await run("init")

    expect(stderr).not.toContain("named no package")
  })
})
