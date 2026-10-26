import { join } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/index"

const workspace = useScratchWorkspace("tsconfig-paths")

/** A string is written as it stands, so a case can hold comments; anything else as JSON. */
type Files = Readonly<Record<string, string | object>>

async function write(files: Files, under = ""): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const text = typeof content === "string" ? content : JSON.stringify(content)
    await workspace.writeSource(join(under, path), text)
  }
}

function resolverAt(workspaceRoot: string, logger = recordingLogger()) {
  const resolver = langTypescriptPlugin.createImportResolver({ workspaceRoot, log: logger })
  return (specifier: string, fromFile = "src/main.ts") => resolver.resolve(specifier, fromFile)
}

const paths = (map: Record<string, string[]>, extra: object = {}) => ({
  compilerOptions: { paths: map, ...extra },
})

describe("the TypeScript import resolver — `compilerOptions.paths`", () => {
  it.each<[string, Files, string, string, string[]]>([
    [
      "an exact key",
      { "tsconfig.json": paths({ "@app/common": ["libs/common/src/index.ts"] }) },
      "@app/common",
      "src/main.ts",
      ["libs/common/src/index.ts"],
    ],
    [
      "a wildcard key, its match put in place of the substitution's `*`",
      { "tsconfig.json": paths({ "@app/*": ["libs/*/src"] }) },
      "@app/common",
      "src/main.ts",
      ["libs/common/src"],
    ],
    [
      "the wildcard key with the longest prefix",
      { "tsconfig.json": paths({ "@app/*": ["a/*"], "@app/common/*": ["b/*"] }) },
      "@app/common/x",
      "src/main.ts",
      ["b/x"],
    ],
    [
      "an exact key over a wildcard one",
      { "tsconfig.json": paths({ "@app/*": ["a/*"], "@app/common": ["c"] }) },
      "@app/common",
      "src/main.ts",
      ["c"],
    ],
    [
      "every substitution, in the order written",
      { "tsconfig.json": paths({ "@x/*": ["one/*", "two/*"] }) },
      "@x/y",
      "src/main.ts",
      ["one/y", "two/y"],
    ],
    [
      "a key that matches nothing",
      { "tsconfig.json": paths({ "@app/*": ["libs/*"] }) },
      "@nestjs/common",
      "src/main.ts",
      [],
    ],
    [
      "`baseUrl`, which `paths` resolve against and which a bare specifier falls back to",
      { "tsconfig.json": paths({ "@/*": ["*"] }, { baseUrl: "src" }) },
      "@/x",
      "src/main.ts",
      ["src/x", "src/@/x"],
    ],
    [
      "a substitution that leaves the workspace, which is dropped",
      { "tsconfig.json": paths({ "@ext/*": ["../outside/*", "inside/*"] }) },
      "@ext/a",
      "src/main.ts",
      ["inside/a"],
    ],
    [
      "comments and trailing commas, which a tsconfig may hold",
      {
        "tsconfig.json": `{
          // the shared libraries
          "compilerOptions": { "paths": { "@lib/*": ["libs/*",], }, },
        }`,
      },
      "@lib/a",
      "src/main.ts",
      ["libs/a"],
    ],
  ])("maps %s", async (_case, files, specifier, fromFile, expected) => {
    await write(files)
    expect(await resolverAt(workspace.root)(specifier, fromFile)).toEqual(expected)
  })
})

describe("the TypeScript import resolver — which config applies", () => {
  it.each<[string, Files, string, string[]]>([
    [
      "the nearest tsconfig.json above the file",
      {
        "tsconfig.json": paths({ "@a": ["root"] }),
        "packages/p/tsconfig.json": paths({ "@a": ["own"] }),
      },
      "packages/p/src/x.ts",
      ["packages/p/own"],
    ],
    [
      "a jsconfig.json where no tsconfig.json sits beside it",
      { "jsconfig.json": paths({ "@a": ["js"] }) },
      "src/x.js",
      ["js"],
    ],
    [
      "the tsconfig.json over a jsconfig.json beside it",
      { "tsconfig.json": paths({ "@a": ["ts"] }), "jsconfig.json": paths({ "@a": ["js"] }) },
      "src/x.ts",
      ["ts"],
    ],
    [
      "`paths` an extended config declares, against that config's directory",
      {
        "tsconfig.base.json": paths({ "@a": ["libs/a"] }),
        "apps/api/tsconfig.json": { extends: "../../tsconfig.base.json" },
      },
      "apps/api/src/main.ts",
      ["libs/a"],
    ],
    [
      "an extended config named without its `.json`",
      {
        "tsconfig.base.json": paths({ "@a": ["libs/a"] }),
        "tsconfig.json": { extends: "./tsconfig.base" },
      },
      "src/main.ts",
      ["libs/a"],
    ],
    [
      "the extending config's own `paths`, which replace the extended ones whole",
      {
        "tsconfig.base.json": paths({ "@a": ["base"] }),
        "tsconfig.json": { extends: "./tsconfig.base.json", ...paths({ "@b": ["own"] }) },
      },
      "src/main.ts",
      [],
    ],
    [
      "the last of several extended configs",
      {
        "one.json": paths({ "@a": ["one"] }),
        "two.json": paths({ "@a": ["two"] }),
        "tsconfig.json": { extends: ["./one.json", "./two.json"] },
      },
      "src/main.ts",
      ["two"],
    ],
    [
      `a package's config, with \`\${configDir}\` read as the extending config's directory`,
      {
        "node_modules/@repo/tsconfig/base.json": paths({ "@a": [`\${configDir}/src/a`] }),
        "apps/web/tsconfig.json": { extends: "@repo/tsconfig/base.json" },
      },
      "apps/web/src/page.ts",
      ["apps/web/src/a"],
    ],
    [
      "configs that extend each other",
      {
        "a.json": { extends: "./tsconfig.json", ...paths({ "@a": ["from-a"] }) },
        "tsconfig.json": { extends: "./a.json" },
      },
      "src/main.ts",
      ["from-a"],
    ],
    ["no config at all", {}, "src/main.ts", []],
  ])("reads %s", async (_case, files, fromFile, expected) => {
    await write(files)
    expect(await resolverAt(workspace.root)("@a", fromFile)).toEqual(expected)
  })

  it("reads no config above the workspace root", async () => {
    await write({ "tsconfig.json": paths({ "@a": ["ws/libs/a"] }), "ws/src/main.ts": "" })
    expect(await resolverAt(join(workspace.root, "ws"))("@a")).toEqual([])
  })

  it("warns once about a config that is not JSON, and maps nothing through it", async () => {
    const logger = recordingLogger()
    await write({ "tsconfig.json": `{ "compilerOptions": { "paths": { "@a": ["a"] } }` })
    const resolve = resolverAt(workspace.root, logger)

    expect(await resolve("@a")).toEqual([])
    expect(await resolve("@a", "src/other.ts")).toEqual([])
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toMatch(/^tsconfig\.json is not valid JSON/)
  })

  it("reads a config edited between two scans afresh, since each scan creates its own resolver", async () => {
    await write({ "tsconfig.json": paths({ "@a": ["before"] }) })
    expect(await resolverAt(workspace.root)("@a")).toEqual(["before"])

    await write({ "tsconfig.json": paths({ "@a": ["after"] }) })
    expect(await resolverAt(workspace.root)("@a")).toEqual(["after"])
  })
})
