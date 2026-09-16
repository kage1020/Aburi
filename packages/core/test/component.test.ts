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

  it("writes description as an explicit null on both detection paths (ir-schema.md §1.1)", async () => {
    // Class A: the key is present carrying `null`, never omitted. Detection has no source
    // for a description, but the config path in @aburi/cli writes the same key from
    // `components[].description`, and a Component must not change shape depending on which
    // producer made it. `Object.hasOwn` rather than a value check -- `undefined` and `null`
    // both read as falsy, and only the former disappears from the serialized JSON.
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8")
    const pkg = await makeDir(tmp, "packages", "alpha")
    await writeJson(join(pkg, "package.json"), { name: "alpha" })
    await seedTypescriptFiles(pkg, 12)
    const workspaceComponents = await detectComponents({ workspaceRoot: tmp })
    expect(workspaceComponents).toHaveLength(1)
    expect(Object.hasOwn(workspaceComponents[0] ?? {}, "description")).toBe(true)
    expect(workspaceComponents[0]?.description).toBeNull()

    const solo = await mkdtemp(join(tmpdir(), "aburi-core-component-solo-"))
    try {
      await writeJson(join(solo, "package.json"), { name: "solo" })
      await seedTypescriptFiles(solo, 12)
      const singleProject = await detectComponents({ workspaceRoot: solo })
      expect(singleProject).toHaveLength(1)
      expect(Object.hasOwn(singleProject[0] ?? {}, "description")).toBe(true)
      expect(singleProject[0]?.description).toBeNull()
    } finally {
      await rm(solo, { recursive: true, force: true })
    }
  })

  it("CD7: scoped npm names fold the scope into the id", async () => {
    // The scope is the part of a published name that already tells two same-named packages
    // apart. Discarding it made `@alpha/utils` and `@beta/utils` one id and left the
    // collision passes — which, under the usual flat `packages/*`, can only count — to
    // separate them.
    expect(__testing_component.toIdFromNpmName("@scope/billing")).toBe("scope-billing")
    expect(__testing_component.toIdFromNpmName("billing")).toBe("billing")
    // `@scope/` is a name §4.2 can use and §4.1 cannot: no id, so the next manifest is asked.
    expect(__testing_component.toIdFromNpmName("@scope/")).toBeNull()
    expect(__testing_component.toIdFromNpmName("@scope")).toBeNull()
    expect(__testing_component.toIdFromNpmName("")).toBeNull()
  })

  it("keeps sibling ids where they were when an unrelated package is added", async () => {
    // The bug this replaces: with every package directly under `packages/`, the parent
    // suffix was `-packages` for all of them and the tie-break fell to a positional counter,
    // so `utils-packages-2` / `utils-packages-3` moved down one the moment a package sorting
    // ahead of them appeared. Component id keys `Symbol.component`, both `Dependency`
    // endpoints and cross-revision comparison, so that read as every component replaced.
    async function idsOf(scopes: ReadonlyArray<[string, string]>): Promise<string[]> {
      const root = await setupTmp()
      try {
        await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8")
        for (const [scope, dir] of scopes) {
          const pkg = await makeDir(root, "packages", dir)
          await writeJson(join(pkg, "package.json"), { name: `@${scope}/utils` })
          await seedTypescriptFiles(pkg, 12)
        }
        const components = await detectComponents({ workspaceRoot: root })
        return components.map((c) => `${c.roots[0]}=${c.id}`)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    const before = await idsOf([
      ["beta", "b-utils"],
      ["gamma", "c-utils"],
    ])
    expect(before).toEqual(["packages/b-utils=beta-utils", "packages/c-utils=gamma-utils"])

    const after = await idsOf([
      ["alpha", "a-utils"],
      ["beta", "b-utils"],
      ["gamma", "c-utils"],
    ])
    expect(after).toEqual([
      "packages/a-utils=alpha-utils",
      "packages/b-utils=beta-utils",
      "packages/c-utils=gamma-utils",
    ])
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

  it("falls back to a root hash when no ancestor segment can form a suffix", async () => {
    // The ancestor pass would otherwise build "app-", which is not a valid id. Both roots
    // take the hash rather than one of them keeping the bare id: "which one came first" is
    // the input the whole pass exists to keep out of a Component id.
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - '**/app'\n", "utf8")
    for (const parent of ["--", "---"]) {
      const pkg = await makeDir(tmp, parent, "app")
      await writeJson(join(pkg, "package.json"), {})
      await seedTypescriptFiles(pkg, 12)
    }
    const components = await detectComponents({ workspaceRoot: tmp })
    const ids = components.map((c) => c.id)
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^app-[0-9a-f]{8}$/)
    expect(new Set(ids).size).toBe(2)
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

  it("CD10: normalizes publicApi entries, which decide both an identity and an order", async () => {
    // The `Set` collapses duplicates and the result is sorted, so the spelling decides both
    // (ir-schema.md §1.2). `@aburi/diff` then compares this array against the previous
    // revision's, which was read off disk and is therefore normalized — so an un-normalized
    // entry here reports a `publicApiChanged` for a component nobody touched.
    const decomposed = "café".normalize("NFD")
    const composed = decomposed.normalize("NFC")
    const manifest = {
      name: "lib",
      exports: { ".": `./src/${decomposed}.ts` },
      main: `./src/${composed}.ts`,
    }
    // One entry, not two: the two spellings are one path.
    expect(__testing_component.collectPublicApi(manifest)).toEqual([`src/${composed}.ts`])
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
    // Named differently on purpose: with two manifests agreeing, one Component would follow
    // from either of them winning, and the dedup this row is about would not be what was shown.
    await writeJson(join(billing, "project.json"), { name: "billing-e2e" })
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

  it("collision resolution: a shared parent segment takes one more step up the path", async () => {
    // team1/shared/pkg and team2/shared/pkg both suffix to "pkg-shared", so the pass walks
    // one directory further up and each id names the team it belongs to.
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
    expect(ids).toEqual(["pkg-shared-team1", "pkg-shared-team2"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("collision resolution: a three-way collision separates on the path, not a counter", async () => {
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
    expect(ids).toEqual(["pkg-shared-a", "pkg-shared-b", "pkg-shared-c"])
  })
})
