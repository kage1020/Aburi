import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { __testing_component, detectComponents, type IgnoredPublicApiReason } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-component")

describe("detectComponents", () => {
  it("synthesizes one Component per pnpm workspace, id from package.json#name", async () => {
    await tree.writePnpmWorkspace("packages/*")
    for (const name of ["alpha", "beta", "gamma"]) {
      await tree.writePackage(`packages/${name}`, { name })
    }

    const { components } = await detectComponents({ workspaceRoot: tree.root })

    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual([
      "packages/alpha=alpha",
      "packages/beta=beta",
      "packages/gamma=gamma",
    ])
  })

  it("returns the workspace root as the one Component when no manager fires", async () => {
    await tree.writePackage(".", { name: "solo" })

    const { components } = await detectComponents({ workspaceRoot: tree.root })

    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual([".=solo"])
  })

  it("names a root that holds no manifest after its directory, kebab-cased", async () => {
    await tree.mkdir("Store Front")

    const { components } = await detectComponents({ workspaceRoot: join(tree.root, "Store Front") })

    expect(components.map((c) => [c.id, c.name])).toEqual([["store-front", "Store Front"]])
  })

  it.each<[string, () => Promise<void>]>([
    [
      "a pnpm workspace",
      async () => {
        await tree.writePnpmWorkspace("packages/*")
        await tree.writePackage("packages/alpha", { name: "alpha" })
      },
    ],
    ["a single project", () => tree.writePackage(".", { name: "solo" })],
  ])("writes description as an explicit null for %s", async (_layout, write) => {
    await write()

    const { components } = await detectComponents({ workspaceRoot: tree.root })

    expect(components).toHaveLength(1)
    expect(Object.hasOwn(components[0] ?? {}, "description")).toBe(true)
    expect(components[0]?.description).toBeNull()
  })

  it("produces one Component for a path nx and pnpm both declare", async () => {
    await tree.writePnpmWorkspace("apps/*")
    await tree.writeJson("nx.json", {})
    await tree.writePackage("apps/billing", { name: "billing" })
    await tree.writeJson("apps/billing/project.json", { name: "billing-e2e" })

    const { components } = await detectComponents({ workspaceRoot: tree.root })

    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual(["apps/billing=billing"])
  })

  it("reports a value that gave no publicApi entry under the id its component ends with", async () => {
    await tree.writePnpmWorkspace("apps/*", "libs/*")
    await tree.writePackage("apps/web", { name: "web", main: "./lib/" })
    await tree.writePackage("libs/web", { name: "web", exports: { ".": "./", "./a": "./a.js" } })

    const { components, ignoredPublicApi } = await detectComponents({ workspaceRoot: tree.root })

    const idAt = (root: string) => components.find((c) => c.roots[0] === root)?.id
    expect(ignoredPublicApi).toEqual([
      {
        component: idAt("apps/web"),
        manifestPath: "apps/web/package.json",
        field: "main",
        value: "./lib/",
        reason: "directory",
      },
      {
        component: idAt("libs/web"),
        manifestPath: "libs/web/package.json",
        field: 'exports["."]',
        value: "./",
        reason: "package-directory",
      },
    ])
    expect(new Set(ignoredPublicApi.map((value) => value.component)).size).toBe(2)
  })

  it("names the root package.json for a single project", async () => {
    await tree.writePackage(".", { name: "solo", types: "/index.d.ts" })

    const { ignoredPublicApi } = await detectComponents({ workspaceRoot: tree.root })

    expect(ignoredPublicApi).toEqual([
      {
        component: "solo",
        manifestPath: "package.json",
        field: "types",
        value: "/index.d.ts",
        reason: "absolute-path",
      },
    ])
  })
})

describe("frameworks from package.json dependencies", () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ["dependencies", { dependencies: { "@nestjs/core": "^10.0.0" } }, ["nestjs"]],
    [
      "every dependency block together",
      {
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
        devDependencies: { "@trpc/server": "^10.0.0" },
        peerDependencies: { vue: "^3.0.0" },
        optionalDependencies: { hono: "^4.0.0" },
      },
      ["hono", "nextjs", "react", "trpc", "vue"],
    ],
    [
      "two packages of one framework, once",
      { dependencies: { svelte: "^4.0.0", "@sveltejs/kit": "^2.0.0" } },
      ["svelte"],
    ],
    ["no dependency blocks", {}, []],
  ])("reads %s", (_case, manifest, frameworks) => {
    expect(__testing_component.collectFrameworks({ name: "pkg", ...manifest })).toEqual(frameworks)
  })
})

describe("the public API from package.json", () => {
  const decomposed = "café".normalize("NFD")
  const composed = decomposed.normalize("NFC")
  const collect = (manifest: Record<string, unknown>, root = ".") =>
    __testing_component.collectPublicApi({ name: "lib", ...manifest }, root)

  it.each<[string, Record<string, unknown>, string[]]>([
    [
      "every target of an exports map",
      { exports: { ".": "./src/index.ts", "./client": "./src/client.ts" } },
      ["src/client.ts", "src/index.ts"],
    ],
    [
      "conditional and array exports",
      { exports: { ".": { import: "./dist/a.mjs", require: ["./dist/a.cjs"] } } },
      ["dist/a.cjs", "dist/a.mjs"],
    ],
    [
      "main, module, types and typings",
      {
        main: "./dist/index.cjs",
        module: "./dist/index.mjs",
        types: "./dist/index.d.ts",
        typings: "./dist/legacy.d.ts",
      },
      ["dist/index.cjs", "dist/index.d.ts", "dist/index.mjs", "dist/legacy.d.ts"],
    ],
    [
      "the files of an exports map and not the folders it maps",
      { exports: { ".": "./src/ok.js", "./": "./", "./lib/": "./lib/" } },
      ["src/ok.js"],
    ],
    [
      "a first segment of two letters before a colon, which is no drive",
      { main: "ab:index.js" },
      ["ab:index.js"],
    ],
    ["one entry for a repeated leading `./`", { main: "././dist/index.js" }, ["dist/index.js"]],
    ["one entry for an inner `.` segment", { module: "./dist/./index.js" }, ["dist/index.js"]],
    ["one entry for a doubled slash", { types: "dist//index.js" }, ["dist/index.js"]],
    [
      "one entry for two spellings of one path, in NFC",
      { exports: { ".": `./src/${decomposed}.ts` }, main: `./src/${composed}.ts` },
      [`src/${composed}.ts`],
    ],
  ])("collects %s", (_case, manifest, entries) => {
    expect(collect(manifest).entries).toEqual(entries)
  })

  it("writes each entry from the workspace root, through the package's directory", () => {
    const manifest = { exports: { ".": "./src/index.ts", "./*": "./src/*.ts" } }

    expect(collect(manifest, "packages/a").entries).toEqual([
      "packages/a/src/*.ts",
      "packages/a/src/index.ts",
    ])
  })

  it.each<[string, Record<string, unknown>, [string, string, IgnoredPublicApiReason][]]>([
    [
      "the package directory",
      { main: "./", module: ".", types: "./.", typings: "" },
      [
        ["main", "./", "package-directory"],
        ["module", ".", "package-directory"],
        ["types", "./.", "package-directory"],
        ["typings", "", "package-directory"],
      ],
    ],
    [
      "a directory inside it",
      { main: "./lib/", module: "./lib/.", types: "lib/", typings: "lib/." },
      [
        ["main", "./lib/", "directory"],
        ["module", "./lib/.", "directory"],
        ["types", "lib/", "directory"],
        ["typings", "lib/.", "directory"],
      ],
    ],
    [
      "the folders an exports map maps, named by where they sit in it",
      { exports: { "./": "./", "./lib/": { import: ["./lib/"] } } },
      [
        ['exports["./"]', "./", "package-directory"],
        ['exports["./lib/"]["import"][0]', "./lib/", "directory"],
      ],
    ],
    [
      "a path that is absolute or leaves the package",
      {
        main: "/",
        module: "/dist/index.mjs",
        types: "C:/dist/index.d.ts",
        typings: "../shared/index.d.ts",
      },
      [
        ["main", "/", "absolute-path"],
        ["module", "/dist/index.mjs", "absolute-path"],
        ["types", "C:/dist/index.d.ts", "drive-shaped-name"],
        ["typings", "../shared/index.d.ts", "parent-segment"],
      ],
    ],
    [
      "a first segment read as a drive",
      { main: "a:index.js" },
      [["main", "a:index.js", "drive-shaped-name"]],
    ],
    [
      "a `..` segment that stays inside the package",
      { exports: "dist/../index.js" },
      [["exports", "dist/../index.js", "parent-segment"]],
    ],
    [
      "a backslash",
      { exports: { ".": "dist\\index.js" } },
      [['exports["."]', "dist\\index.js", "unspellable-name"]],
    ],
    [
      "a value that is not a string, which is not a path written wrong",
      { exports: { "./internal/*": null }, main: 42, module: true, types: {}, typings: null },
      [],
    ],
  ])("gives no entry for %s, and says which value and why", (_case, manifest, ignored) => {
    const publicApi = collect(manifest)

    expect(publicApi.entries).toEqual([])
    expect(publicApi.ignored).toEqual(
      ignored.map(([field, value, reason]) => ({ field, value, reason })),
    )
  })
})
