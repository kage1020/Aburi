import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { __testing_component, detectComponents } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-component")

describe("detectComponents", () => {
  it("synthesizes one Component per pnpm workspace, id from package.json#name", async () => {
    await tree.writePnpmWorkspace("packages/*")
    for (const name of ["alpha", "beta", "gamma"]) {
      await tree.writePackage(`packages/${name}`, { name })
    }

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual([
      "packages/alpha=alpha",
      "packages/beta=beta",
      "packages/gamma=gamma",
    ])
  })

  it("returns the workspace root as the one Component when no manager fires", async () => {
    await tree.writePackage(".", { name: "solo" })

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual([".=solo"])
  })

  it("names a root that holds no manifest after its directory, kebab-cased", async () => {
    await tree.mkdir("Store Front")

    const components = await detectComponents({ workspaceRoot: join(tree.root, "Store Front") })

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

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components).toHaveLength(1)
    expect(Object.hasOwn(components[0] ?? {}, "description")).toBe(true)
    expect(components[0]?.description).toBeNull()
  })

  it("produces one Component for a path nx and pnpm both declare", async () => {
    await tree.writePnpmWorkspace("apps/*")
    await tree.writeJson("nx.json", {})
    await tree.writePackage("apps/billing", { name: "billing" })
    await tree.writeJson("apps/billing/project.json", { name: "billing-e2e" })

    const components = await detectComponents({ workspaceRoot: tree.root })

    expect(components.map((c) => `${c.roots[0]}=${c.id}`)).toEqual(["apps/billing=billing"])
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
    ["no path written with a backslash or left empty", { main: "dist\\index.js", types: "" }, []],
    [
      "one entry for two spellings of one path, in NFC",
      { exports: { ".": `./src/${decomposed}.ts` }, main: `./src/${composed}.ts` },
      [`src/${composed}.ts`],
    ],
  ])("collects %s", (_case, manifest, publicApi) => {
    expect(__testing_component.collectPublicApi({ name: "lib", ...manifest })).toEqual(publicApi)
  })
})
