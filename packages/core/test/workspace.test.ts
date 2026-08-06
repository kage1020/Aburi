import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CoreError, detectManagers, detectWorkspaceRoot } from "../src/index"

async function setupTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aburi-core-workspace-"))
}

describe("detectWorkspaceRoot", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await setupTmp()
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("recognizes pnpm-workspace.yaml as a marker", async () => {
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages: ['apps/*']", "utf8")
    expect(await detectWorkspaceRoot({ cwd: tmp })).toBe(tmp)
  })

  it("prefers the outermost marker over an inner package.json#workspaces", async () => {
    await mkdir(join(tmp, ".git"), { recursive: true })
    const inner = join(tmp, "apps", "billing")
    await mkdir(inner, { recursive: true })
    await writeFile(
      join(inner, "package.json"),
      JSON.stringify({ name: "billing", workspaces: ["lib/*"] }),
      "utf8",
    )
    expect(await detectWorkspaceRoot({ cwd: inner })).toBe(tmp)
  })

  it("recognizes package.json with workspaces field as a marker", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
      "utf8",
    )
    expect(await detectWorkspaceRoot({ cwd: tmp })).toBe(tmp)
  })

  it("ignores plain package.json (no workspaces field)", async () => {
    await writeFile(join(tmp, "package.json"), JSON.stringify({ name: "plain-pkg" }), "utf8")
    let caught: unknown
    try {
      await detectWorkspaceRoot({ cwd: tmp })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect((caught as CoreError).code).toBe("workspace-root-not-found")
  })

  it("recognizes Cargo.toml [workspace]", async () => {
    await writeFile(join(tmp, "Cargo.toml"), '[workspace]\nmembers = ["crate-a"]\n', "utf8")
    expect(await detectWorkspaceRoot({ cwd: tmp })).toBe(tmp)
  })

  it("recognizes pyproject.toml [tool.uv.workspace]", async () => {
    await writeFile(
      join(tmp, "pyproject.toml"),
      '[tool.uv.workspace]\nmembers = ["pkg-a"]\n',
      "utf8",
    )
    expect(await detectWorkspaceRoot({ cwd: tmp })).toBe(tmp)
  })

  it("recognizes turbo.json + nx.json + lerna.json + .git markers", async () => {
    for (const marker of ["turbo.json", "nx.json", "lerna.json"]) {
      await rm(tmp, { recursive: true, force: true })
      tmp = await setupTmp()
      await writeFile(join(tmp, marker), "{}", "utf8")
      expect(await detectWorkspaceRoot({ cwd: tmp })).toBe(tmp)
    }
  })
})

describe("detectManagers", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await setupTmp()
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("resolves pnpm packages globs into workspace candidates", async () => {
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8")
    await mkdir(join(tmp, "apps", "billing"), { recursive: true })
    await mkdir(join(tmp, "apps", "pricing"), { recursive: true })
    await writeFile(
      join(tmp, "apps", "billing", "package.json"),
      JSON.stringify({ name: "billing" }),
      "utf8",
    )
    await writeFile(
      join(tmp, "apps", "pricing", "package.json"),
      JSON.stringify({ name: "pricing" }),
      "utf8",
    )
    const result = await detectManagers(tmp)
    expect(result.managers.find((m) => m.tool === "pnpm")).toBeDefined()
    expect(result.workspaces.map((w) => w.relativeRoot).sort()).toEqual([
      "apps/billing",
      "apps/pricing",
    ])
  })

  it("resolves npm workspaces array", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
      "utf8",
    )
    await mkdir(join(tmp, "apps", "a"), { recursive: true })
    await writeFile(join(tmp, "apps", "a", "package.json"), JSON.stringify({ name: "a" }), "utf8")
    const result = await detectManagers(tmp)
    expect(result.managers.map((m) => m.tool)).toContain("npm")
    expect(result.workspaces.map((w) => w.relativeRoot)).toEqual(["apps/a"])
  })

  it("identifies yarn via yarn.lock even when workspaces look generic", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
      "utf8",
    )
    await writeFile(join(tmp, "yarn.lock"), "", "utf8")
    await mkdir(join(tmp, "apps", "a"), { recursive: true })
    await writeFile(join(tmp, "apps", "a", "package.json"), JSON.stringify({ name: "a" }), "utf8")
    const result = await detectManagers(tmp)
    expect(result.managers.map((m) => m.tool)).toContain("yarn")
  })

  it("resolves nx project.json files into candidates", async () => {
    await writeFile(join(tmp, "nx.json"), "{}", "utf8")
    await mkdir(join(tmp, "libs", "shared"), { recursive: true })
    await writeFile(join(tmp, "libs", "shared", "project.json"), "{}", "utf8")
    const result = await detectManagers(tmp)
    expect(result.managers.map((m) => m.tool)).toContain("nx")
    expect(result.workspaces.find((w) => w.relativeRoot === "libs/shared")).toBeDefined()
  })

  it("records turbo as a co-marker without emitting workspaces", async () => {
    await writeFile(join(tmp, "turbo.json"), "{}", "utf8")
    const result = await detectManagers(tmp)
    const turbo = result.managers.find((m) => m.tool === "turbo")
    expect(turbo).toBeDefined()
    expect(turbo?.roots).toEqual([])
  })

  it("refuses a declared package that lies outside the workspace root", async () => {
    // `tinyglobby` honours the ascending pattern and returns the match above `cwd`, which
    // is what makes this reachable at all. `assertInsideWorkspace` carries the reasoning.
    const outside = join(tmp, "outside")
    await mkdir(join(outside, "pkg"), { recursive: true })
    await writeFile(join(outside, "pkg", "package.json"), JSON.stringify({ name: "o" }), "utf8")
    const root = join(tmp, "repo")
    await mkdir(join(root, "apps", "a"), { recursive: true })
    await writeFile(join(root, "apps", "a", "package.json"), JSON.stringify({ name: "a" }), "utf8")
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - ../outside/*\n",
      "utf8",
    )

    let caught: unknown
    try {
      await detectManagers(root)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect((caught as CoreError).code).toBe("workspace-root-outside")
    expect((caught as CoreError).message).toContain("pnpm workspace root")
    expect((caught as CoreError).value).toContain("..")
  })

  it("spells a workspace root in Unicode NFC, as the paths beside it are spelled", async () => {
    // `symbols[].source.file` is normalized at its source (`toPosixRelative`). A root left
    // in the spelling the filesystem handed back would disagree with it for the same
    // directory, which is the divergence canonical serialization exists to prevent.
    // Written decomposed on purpose: `e` + U+0301, the spelling an archive, an HFS+
    // volume or a Finder rename hands back.
    const decomposed = "café"
    await mkdir(join(tmp, "apps", decomposed), { recursive: true })
    await writeFile(
      join(tmp, "apps", decomposed, "package.json"),
      JSON.stringify({ name: "cafe" }),
      "utf8",
    )
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8")

    const result = await detectManagers(tmp)
    expect(result.workspaces.map((w) => w.relativeRoot)).toEqual([
      `apps/${decomposed.normalize("NFC")}`,
    ])
  })

  it("dedupes the same workspace path under one tool entry", async () => {
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8")
    await mkdir(join(tmp, "apps", "billing"), { recursive: true })
    await writeFile(
      join(tmp, "apps", "billing", "package.json"),
      JSON.stringify({ name: "billing" }),
      "utf8",
    )
    const result = await detectManagers(tmp)
    expect(result.workspaces.filter((w) => w.relativeRoot === "apps/billing")).toHaveLength(1)
  })
})
