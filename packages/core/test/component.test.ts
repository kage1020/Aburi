import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __testing_component, detectComponents } from "../src/index"

async function setupTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aburi-core-component-"))
}

async function makeDir(root: string, ...parts: string[]): Promise<string> {
  const path = join(root, ...parts)
  await mkdir(path, { recursive: true })
  return path
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8")
}

/**
 * Write enough source files inside a directory to clear the language-frequency thresholds
 * (≥10 files AND ≥5% share). Using a small per-package corpus keeps tests fast while still
 * matching the production detector's branch.
 */
async function seedTypescriptFiles(dir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await writeFile(join(dir, `f${i}.ts`), `export const x${i} = ${i}`, "utf8")
  }
}

describe("detectComponents", () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await setupTmp()
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it("CD1: synthesizes one Component per pnpm workspace, id from package.json#name", async () => {
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8")
    for (const name of ["alpha", "beta", "gamma"]) {
      const pkg = await makeDir(tmp, "packages", name)
      await writeJson(join(pkg, "package.json"), { name })
      await seedTypescriptFiles(pkg, 12)
    }
    const components = await detectComponents({ workspaceRoot: tmp })
    expect(components.map((c) => c.id)).toEqual(["alpha", "beta", "gamma"])
    expect(components[0]?.roots).toEqual(["packages/alpha"])
  })

  it("CD6: returns a single-project Component when no manager fires", async () => {
    await writeJson(join(tmp, "package.json"), { name: "solo" })
    await seedTypescriptFiles(tmp, 12)
    const components = await detectComponents({ workspaceRoot: tmp })
    expect(components).toHaveLength(1)
    expect(components[0]?.id).toBe("solo")
    expect(components[0]?.roots).toEqual(["."])
  })

  it("CD7: scoped npm names strip the scope and become the id", async () => {
    expect(__testing_component.toIdFromNpmName("@scope/billing")).toBe("billing")
  })

  it("accepts a digit-leading package name, which npm allows and detection must not reject", async () => {
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8")
    for (const name of ["3d-renderer", "7zip-bin"]) {
      const pkg = await makeDir(tmp, "packages", name)
      await writeJson(join(pkg, "package.json"), { name })
      await seedTypescriptFiles(pkg, 12)
    }
    const components = await detectComponents({ workspaceRoot: tmp })
    expect(components.map((c) => c.id)).toEqual(["3d-renderer", "7zip-bin"])
  })

  it("aborts with an origin-carrying error when a name cannot yield an id at all", async () => {
    // A name that kebab-cases to the empty string has no id to fall back on. The message
    // has to name the package it came from: "" alone tells the reader nothing.
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8")
    const pkg = await makeDir(tmp, "packages", "widgets")
    await writeJson(join(pkg, "package.json"), { name: "---" })
    await seedTypescriptFiles(pkg, 12)
    await expect(detectComponents({ workspaceRoot: tmp })).rejects.toThrowError(
      expect.objectContaining({ code: "invalid-component-id" }),
    )
    await expect(detectComponents({ workspaceRoot: tmp })).rejects.toThrowError(
      /package name "---".*packages\/widgets/s,
    )
  })

  it("resolves a collision numerically when the parent segment cannot form a suffix", async () => {
    // The parent-suffix pass would otherwise build "app-", which is not a valid id — the
    // collision is resolvable without failing detection for components whose own ids are fine.
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - '**/app'\n", "utf8")
    for (const parent of ["--", "---"]) {
      const pkg = await makeDir(tmp, parent, "app")
      await writeJson(join(pkg, "package.json"), {})
      await seedTypescriptFiles(pkg, 12)
    }
    const components = await detectComponents({ workspaceRoot: tmp })
    expect(components.map((c) => c.id)).toEqual(["app", "app-2"])
  })

  it("CD9: dependency-driven framework detection (nestjs)", async () => {
    const manifest = {
      name: "billing",
      dependencies: { "@nestjs/core": "^10.0.0" },
    }
    expect(__testing_component.collectFrameworks(manifest)).toEqual(["nestjs"])
  })

  it("CD9: detects multiple frameworks from combined dep blocks", async () => {
    const manifest = {
      name: "web",
      dependencies: { next: "^14.0.0", react: "^18.0.0" },
      devDependencies: { "@trpc/server": "^10.0.0" },
    }
    expect(__testing_component.collectFrameworks(manifest)).toEqual(["nextjs", "react", "trpc"])
  })

  it("CD10: exports map keys produce publicApi entries", async () => {
    const manifest = {
      name: "lib",
      exports: { ".": "./src/index.ts", "./client": "./src/client.ts" },
    }
    expect(__testing_component.collectPublicApi(manifest)).toEqual([
      "src/client.ts",
      "src/index.ts",
    ])
  })

  it("CD10: falls back to main/module/types when exports is absent", async () => {
    const manifest = {
      name: "lib",
      main: "./dist/index.cjs",
      module: "./dist/index.mjs",
      types: "./dist/index.d.ts",
    }
    expect(__testing_component.collectPublicApi(manifest)).toEqual([
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/index.mjs",
    ])
  })

  it("CD11: missing package.json falls back to directory name as kebab id", async () => {
    const components = await detectComponents({ workspaceRoot: tmp })
    expect(components[0]?.id.length).toBeGreaterThan(0)
    expect(components[0]?.roots).toEqual(["."])
  })

  it("CD13: nx and pnpm pointing at the same path produce one Component", async () => {
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8")
    await writeFile(join(tmp, "nx.json"), "{}", "utf8")
    const billing = await makeDir(tmp, "apps", "billing")
    await writeJson(join(billing, "package.json"), { name: "billing" })
    await writeFile(join(billing, "project.json"), "{}", "utf8")
    await seedTypescriptFiles(billing, 12)
    const components = await detectComponents({ workspaceRoot: tmp })
    expect(components.filter((c) => c.id === "billing")).toHaveLength(1)
  })

  it("collision resolution: two 'shared' workspaces get parent-dir suffixes", async () => {
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - libs/*\n", "utf8")
    for (const folder of ["apps", "libs"]) {
      const dir = await makeDir(tmp, folder, "shared")
      await writeJson(join(dir, "package.json"), { name: "shared" })
      await seedTypescriptFiles(dir, 12)
    }
    const components = await detectComponents({ workspaceRoot: tmp })
    const ids = components.map((c) => c.id).sort()
    expect(ids).toEqual(["shared-apps", "shared-libs"])
  })

  it("collision resolution: same parent segment falls through to numeric suffix", async () => {
    // team1/shared/pkg and team2/shared/pkg both suffix to "pkg-shared", so the numeric
    // fallback must disambiguate them into pkg-shared and pkg-shared-2.
    await writeFile(
      join(tmp, "pnpm-workspace.yaml"),
      "packages:\n  - team1/*/*\n  - team2/*/*\n",
      "utf8",
    )
    for (const team of ["team1", "team2"]) {
      const dir = await makeDir(tmp, team, "shared", "pkg")
      await writeJson(join(dir, "package.json"), { name: "pkg" })
      await seedTypescriptFiles(dir, 12)
    }
    const components = await detectComponents({ workspaceRoot: tmp })
    const ids = components.map((c) => c.id).sort()
    expect(ids).toEqual(["pkg-shared", "pkg-shared-2"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("collision resolution: three-way collision produces -2 and -3 tails", async () => {
    await writeFile(
      join(tmp, "pnpm-workspace.yaml"),
      "packages:\n  - a/*/*\n  - b/*/*\n  - c/*/*\n",
      "utf8",
    )
    for (const team of ["a", "b", "c"]) {
      const dir = await makeDir(tmp, team, "shared", "pkg")
      await writeJson(join(dir, "package.json"), { name: "pkg" })
      await seedTypescriptFiles(dir, 12)
    }
    const components = await detectComponents({ workspaceRoot: tmp })
    const ids = components.map((c) => c.id).sort()
    expect(ids).toEqual(["pkg-shared", "pkg-shared-2", "pkg-shared-3"])
  })
})
