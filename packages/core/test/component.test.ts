import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Component } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __testing_component,
  detectComponents,
  makeComponentId,
  makeLanguageId,
} from "../src/index"

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

  it("writes description as an explicit null on both detection paths (ir-schema.md)", async () => {
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
    // `@scope/` is a name `name` inference can use and `id` inference cannot: no id, so the
    // next manifest is asked.
    expect(__testing_component.toIdFromNpmName("@scope/")).toBeNull()
    expect(__testing_component.toIdFromNpmName("@scope")).toBeNull()
    expect(__testing_component.toIdFromNpmName("")).toBeNull()
    // A bare part that kebab-cases to nothing is `""`, not the scope: `""` reaches the abort
    // id inference promises, and the scope alone would be one silent id for every unusable
    // name in it.
    expect(__testing_component.toIdFromNpmName("@acme/---")).toBe("")
    expect(__testing_component.toIdFromNpmName("@acme/___")).toBe("")
    expect(__testing_component.toIdFromNpmName("@acme/日本語")).toBe("")
  })

  it("aborts on a scoped name whose bare part cannot be an id, rather than taking the scope", async () => {
    // Folding the scope in must not turn "this name has no id" into "the id is the scope":
    // two such packages in one scope would both become `acme`, collide, and come out of the
    // hash pass with opaque ids and nothing said. component-detect.md says detection aborts and
    // names the
    // package, which is what the unscoped `"---"` case below has always done.
    await writeFile(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8")
    const pkg = await makeDir(tmp, "packages", "widgets")
    await writeJson(join(pkg, "package.json"), { name: "@acme/---" })
    await seedTypescriptFiles(pkg, 12)
    await expect(detectComponents({ workspaceRoot: tmp })).rejects.toThrowError(
      expect.objectContaining({ code: "invalid-component-id" }),
    )
    await expect(detectComponents({ workspaceRoot: tmp })).rejects.toThrowError(
      /package name "@acme\/---".*packages\/widgets/s,
    )
  })

  it("folding the scope in keeps same-named packages from colliding at all", async () => {
    // The first half of the fix, and it never reaches the collision resolver: `@beta/utils`
    // and `@gamma/utils` are distinct ids before `resolveIdCollisions` is asked anything. The
    // test below is the one that exercises the resolver.
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

  it("keeps colliding siblings' ids where they were when one more is added", async () => {
    // The resolver's own regression, in the issue's exact shape: three unscoped packages all
    // named `utils` directly under `packages/`. They share the base id, they share the only
    // ancestor segment, so the path separates nothing and all three land in the hash pass —
    // the branch the positional `-2`, `-3`, … counter used to own. Adding a fourth used to
    // shuffle those tails by root order; every id here is a digest of that component's own
    // root, so the first three come back byte-identical.
    async function idsOf(dirs: readonly string[]): Promise<string[]> {
      const root = await setupTmp()
      try {
        await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8")
        for (const dir of dirs) {
          const pkg = await makeDir(root, "packages", dir)
          await writeJson(join(pkg, "package.json"), { name: "utils" })
          await seedTypescriptFiles(pkg, 12)
        }
        const components = await detectComponents({ workspaceRoot: root })
        // Keyed by root, because `detectComponents` returns components in id order and the
        // whole question here is which id each root ends up with.
        return components
          .map((c) => `${c.roots[0]}=${c.id}`)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    // Literal digests, not a shape probe: the property is that an id is a function of that
    // component's own workspace-relative root, and `/^utils-packages-[0-9a-f]{8}$/` would hold
    // just as well for a random, machine-dependent or index-derived tail. The `-packages` is
    // the ancestor the pass consumed before running out of path; the digest is appended to it.
    const before = await idsOf(["a-utils", "b-utils", "c-utils"])
    expect(before).toEqual([
      "packages/a-utils=utils-packages-b9b98f98",
      "packages/b-utils=utils-packages-446c5bf9",
      "packages/c-utils=utils-packages-d48cea54",
    ])

    const after = await idsOf(["a-utils", "b-utils", "c-utils", "d-utils"])
    expect(after.slice(0, 3)).toEqual(before)
    expect(after[3]).toBe("packages/d-utils=utils-packages-539ec16f")
  })

  it("moves the component whose id a newcomer claims, and only that one", async () => {
    // What the scheme does *not* promise, pinned as expected rather than left to be
    // rediscovered: `taken` is a function of the ids a component contends with, so a package
    // arriving with an id already in use moves the holder one step further up its path. The
    // component in the other subtree is untouched, which is the part that used to fail — under
    // the counter, any package under the same parent renumbered its neighbours.
    async function idsOf(extra: boolean): Promise<string[]> {
      const root = await setupTmp()
      try {
        await writeFile(
          join(root, "pnpm-workspace.yaml"),
          "packages:\n  - team/*/shared\n  - packages/*\n",
          "utf8",
        )
        for (const area of ["apps", "libs"]) {
          const pkg = await makeDir(root, "team", area, "shared")
          await writeJson(join(pkg, "package.json"), { name: "shared" })
          await seedTypescriptFiles(pkg, 12)
        }
        if (extra) {
          const pkg = await makeDir(root, "packages", "x")
          await writeJson(join(pkg, "package.json"), { name: "shared-libs" })
          await seedTypescriptFiles(pkg, 12)
        }
        const components = await detectComponents({ workspaceRoot: root })
        return components.map((c) => `${c.roots[0]}=${c.id}`)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    expect(await idsOf(false)).toEqual([
      "team/apps/shared=shared-apps",
      "team/libs/shared=shared-libs",
    ])
    expect(await idsOf(true)).toEqual([
      // Untouched: nothing contends for `shared-apps`.
      "team/apps/shared=shared-apps",
      "packages/x=shared-libs-packages",
      // Moved, because `packages/x` claims the id it held.
      "team/libs/shared=shared-libs-team",
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
    // Literal digests of the two workspace-relative roots. A `/^app-[0-9a-f]{8}$/` probe would
    // also pass for a tail that was random per run, derived from the absolute tmpdir, or taken
    // from the array index — none of which is a function of the component's own root.
    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual([
      "---/app=app-74a714d5",
      "--/app=app-d2408cdb",
    ])
    // And the same answer twice from the same tree, which no literal can show on its own.
    const second = await detectComponents({ workspaceRoot: tmp })
    expect(second.map((c) => c.id)).toEqual(components.map((c) => c.id))
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
    // (ir-schema.md). `@aburi/diff` then compares this array against the previous
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

  it("refuses to hand back a duplicate id rather than letting `aburi init` write one", async () => {
    // The hash pass separates a group by digest, not by construction, so uniqueness is a
    // check rather than a guarantee. Two components on one root is the only way to force it
    // from a test — a real digest collision is not reachable — and it is the same shape: the
    // path separates nothing and the digests match. Where the result becomes an IR, invariant #2
    // would catch it; `aburi init` builds no IR, so this is the boundary that has to.
    const duplicate = (): Component[] => [
      {
        id: makeComponentId("app"),
        name: "app",
        roots: ["packages/app"],
        languages: [makeLanguageId("ts")],
        description: null,
      },
      {
        id: makeComponentId("app"),
        name: "app",
        roots: ["packages/app"],
        languages: [makeLanguageId("ts")],
        description: null,
      },
    ]
    expect(() => __testing_component.resolveIdCollisions(duplicate())).toThrowError(
      expect.objectContaining({ code: "component-id-collision-unresolved" }),
    )
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
    // Paired with their roots rather than sorted flat: that the three ids differ says nothing
    // about *which* id each component got, and that is the property.
    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual([
      "a/shared/pkg=pkg-shared-a",
      "b/shared/pkg=pkg-shared-b",
      "c/shared/pkg=pkg-shared-c",
    ])
  })
})
