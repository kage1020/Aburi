import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { linkDirectory, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { langTypescriptPlugin } from "../src/index"

const workspace = useScratchWorkspace("tsconfig-paths")

/** A string is written as it stands, so a case can hold comments; anything else as JSON. */
type Files = Readonly<Record<string, string | object>>

async function write(files: Files): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const text = typeof content === "string" ? content : JSON.stringify(content)
    await workspace.writeSource(path, text)
  }
}

function resolverAt(workspaceRoot: string, logger = recordingLogger(), installedRoot?: string) {
  const resolver = langTypescriptPlugin.createImportResolver({
    workspaceRoot,
    ...(installedRoot === undefined ? {} : { installedRoot }),
    log: logger,
  })
  return (specifier: string, fromFile = "src/main.ts") => resolver.resolve(specifier, fromFile)
}

const paths = (map: Record<string, string[]>, extra: object = {}) => ({
  compilerOptions: { paths: map, ...extra },
})

describe("the TypeScript import resolver — `compilerOptions.paths`", () => {
  it.each<[string, Files, string, string[]]>([
    [
      "an exact key",
      { "tsconfig.json": paths({ "@app/common": ["libs/common/src/index.ts"] }) },
      "@app/common",
      ["libs/common/src/index.ts"],
    ],
    [
      "a wildcard key, its match put in place of the substitution's `*`",
      { "tsconfig.json": paths({ "@app/*": ["libs/*/src"] }) },
      "@app/common",
      ["libs/common/src"],
    ],
    [
      "the wildcard key with the longest prefix",
      { "tsconfig.json": paths({ "@app/*": ["a/*"], "@app/common/*": ["b/*"] }) },
      "@app/common/x",
      ["b/x"],
    ],
    [
      "an exact key over a wildcard one",
      { "tsconfig.json": paths({ "@app/*": ["a/*"], "@app/common": ["c"] }) },
      "@app/common",
      ["c"],
    ],
    [
      "every substitution, in the order written",
      { "tsconfig.json": paths({ "@x/*": ["one/*", "two/*"] }) },
      "@x/y",
      ["one/y", "two/y"],
    ],
    [
      "a key that matches nothing",
      { "tsconfig.json": paths({ "@app/*": ["libs/*"] }) },
      "@nestjs/common",
      [],
    ],
    [
      "`baseUrl`, which `paths` resolve against and which a bare specifier falls back to",
      { "tsconfig.json": paths({ "@/*": ["*"] }, { baseUrl: "src" }) },
      "@/x",
      ["src/x", "src/@/x"],
    ],
    [
      "a substitution that leaves the workspace, which is dropped",
      { "tsconfig.json": paths({ "@ext/*": ["../outside/*", "inside/*"] }) },
      "@ext/a",
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
      ["libs/a"],
    ],
  ])("maps %s", async (_case, files, specifier, expected) => {
    await write(files)
    expect(await resolverAt(workspace.root)(specifier)).toEqual(expected)
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
    [
      "`baseUrl` an extended config declares, against that config's directory",
      {
        "tsconfig.base.json": paths({ "@a": ["libs/a"] }, { baseUrl: "." }),
        "apps/api/tsconfig.json": { extends: "../../tsconfig.base.json" },
      },
      "apps/api/src/main.ts",
      ["libs/a", "@a"],
    ],
    [
      "a config saved with a byte order mark",
      { "tsconfig.json": `\uFEFF${JSON.stringify(paths({ "@a": ["bom"] }))}` },
      "src/main.ts",
      ["bom"],
    ],
    [
      "an empty config as one that maps nothing, in place of the one above it",
      { "tsconfig.json": paths({ "@a": ["root"] }), "packages/p/tsconfig.json": " \n" },
      "packages/p/src/x.ts",
      [],
    ],
    ["no config at all", {}, "src/main.ts", []],
  ])("reads %s", async (_case, files, fromFile, expected) => {
    const logger = recordingLogger()
    await write(files)
    expect(await resolverAt(workspace.root, logger)("@a", fromFile)).toEqual(expected)
    expect(logger.warnings).toEqual([])
  })

  it("looks for the nearest config no higher than the workspace root", async () => {
    await write({ "tsconfig.json": paths({ "@a": ["ws/libs/a"] }), "ws/src/main.ts": "" })
    expect(await resolverAt(join(workspace.root, "ws"))("@a")).toEqual([])
  })

  it("follows `extends` out of the workspace root", async () => {
    await write({
      "base.json": paths({ "@a": [`\${configDir}/libs/a`] }),
      "ws/tsconfig.json": { extends: "../base.json" },
    })
    expect(await resolverAt(join(workspace.root, "ws"))("@a")).toEqual(["libs/a"])
  })

  it("reads a config edited between two scans afresh, since each scan creates its own resolver", async () => {
    await write({ "tsconfig.json": paths({ "@a": ["before"] }) })
    expect(await resolverAt(workspace.root)("@a")).toEqual(["before"])

    await write({ "tsconfig.json": paths({ "@a": ["after"] }) })
    expect(await resolverAt(workspace.root)("@a")).toEqual(["after"])
  })
})

describe("the TypeScript import resolver — a config it cannot use", () => {
  it("warns once about a config that is not JSON, where, and maps nothing through it", async () => {
    const logger = recordingLogger()
    await write({ "tsconfig.json": `{\n  "compilerOptions": { "paths": { "@a": ["a"] } }` })
    const resolve = resolverAt(workspace.root, logger)

    expect(await resolve("@a")).toEqual([])
    expect(await resolve("@a", "src/other.ts")).toEqual([])
    expect(logger.warnings).toEqual([
      "tsconfig.json is not valid JSON (CloseBraceExpected at 2:50), so the path aliases it " +
        "declares are not resolved.",
    ])
  })

  it.skipIf(process.platform === "win32")(
    "warns about a config it cannot read, and looks no further up for another",
    async () => {
      const logger = recordingLogger()
      await write({ "tsconfig.json": paths({ "@a": ["root"] }) })
      await mkdir(join(workspace.root, "packages/p"), { recursive: true })
      await symlink("tsconfig.json", join(workspace.root, "packages/p/tsconfig.json"))

      expect(await resolverAt(workspace.root, logger)("@a", "packages/p/src/x.ts")).toEqual([])
      expect(logger.warnings).toEqual([
        expect.stringMatching(/^packages\/p\/tsconfig\.json could not be read \(ELOOP/),
      ])
    },
  )

  it("warns once about an `extends` entry that names no config, and maps what it can", async () => {
    const logger = recordingLogger()
    await write({
      "tsconfig.json": { extends: ["@repo/tsconfig/base.json", "./own.json"] },
      "own.json": paths({ "@a": ["own"] }),
    })
    const resolve = resolverAt(workspace.root, logger)

    expect(await resolve("@a")).toEqual(["own"])
    expect(await resolve("@a", "src/other.ts")).toEqual(["own"])
    expect(logger.warnings).toEqual([
      'tsconfig.json extends "@repo/tsconfig/base.json", but no config file was found for it, ' +
        "so the path aliases it would supply are not resolved.",
    ])
  })

  it.each<[string, object, string[], string]>([
    [
      "`paths` that is not an object",
      { compilerOptions: { paths: ["@a"] } },
      [],
      "declares compilerOptions.paths as a list, not an object, so it maps nothing",
    ],
    [
      "a key whose substitutions are not a list",
      { compilerOptions: { paths: { "@a": "libs/a", "@b": ["libs/b"] } } },
      [],
      'declares paths["@a"] as a string, not a list, so that key maps nothing',
    ],
    [
      "a key with more than one `*`",
      { compilerOptions: { paths: { "@*/*": ["libs/*"], "@a": ["libs/a"] } } },
      ["libs/a"],
      'declares the paths key "@*/*" with more than one "*", so it maps nothing',
    ],
    [
      "a substitution with more than one `*`",
      { compilerOptions: { paths: { "@a": ["libs/*/*", "libs/a"] } } },
      ["libs/a"],
      'declares the substitution "libs/*/*" for "@a" with more than one "*", so it is skipped',
    ],
    [
      "a substitution that is not a string",
      { compilerOptions: { paths: { "@a": [1, "libs/a"] } } },
      ["libs/a"],
      'declares a substitution for "@a" as a number, so it is skipped',
    ],
    [
      "a `baseUrl` that is not a string",
      { compilerOptions: { baseUrl: 1, paths: { "@a": ["libs/a"] } } },
      ["libs/a"],
      "declares compilerOptions.baseUrl as a number, not a string, so it is ignored",
    ],
  ])(
    "warns about %s, which `tsc` refuses, and maps the rest",
    async (_case, config, expected, problem) => {
      const logger = recordingLogger()
      await write({ "tsconfig.json": config })

      expect(await resolverAt(workspace.root, logger)("@a")).toEqual(expected)
      expect(logger.warnings).toEqual([`tsconfig.json ${problem}.`])
    },
  )
})

// `base` is a checkout made without its dependencies, as the base of a refspec diff is; `head` is
// the checkout they are installed in, with a workspace package linked into its `node_modules`.
describe("the TypeScript import resolver — a checkout without its dependencies installed", () => {
  const LINKED = "@repo/tsconfig/base.json"
  const REGISTRY = "@tsconfig/shared"

  async function installHead(files: Files = {}): Promise<void> {
    await write({
      "head/packages/tsconfig/base.json": paths({ "@a": [`\${configDir}/from-head`] }),
      "head/node_modules/@tsconfig/shared/tsconfig.json": paths({
        "@a": [`\${configDir}/from-registry`],
      }),
      ...files,
    })
    await mkdir(join(workspace.root, "head/node_modules/@repo"), { recursive: true })
    await linkDirectory(
      join(workspace.root, "head/packages/tsconfig"),
      join(workspace.root, "head/node_modules/@repo/tsconfig"),
    )
  }

  const baseResolver = (logger = recordingLogger()) =>
    resolverAt(join(workspace.root, "base"), logger, join(workspace.root, "head"))

  it.each<[string, string, Files, string[]]>([
    [
      "a workspace package the installed checkout links, from the workspace's own copy",
      LINKED,
      { "base/packages/tsconfig/base.json": paths({ "@a": [`\${configDir}/from-base`] }) },
      ["apps/web/from-base"],
    ],
    [
      "a linked workspace package the workspace has no copy of, as the installed checkout has it",
      LINKED,
      {},
      ["apps/web/from-head"],
    ],
    ["a package installed from a registry, as installed", REGISTRY, {}, ["apps/web/from-registry"]],
    [
      "a path into `node_modules`, as installed",
      "../../node_modules/@tsconfig/shared/tsconfig.json",
      {},
      ["apps/web/from-registry"],
    ],
    [
      "a package the workspace has installed itself, over the installed checkout's",
      REGISTRY,
      {
        "base/node_modules/@tsconfig/shared/tsconfig.json": paths({
          "@a": [`\${configDir}/from-own-install`],
        }),
      },
      ["apps/web/from-own-install"],
    ],
  ])("reads %s", async (_case, entry, files, expected) => {
    const logger = recordingLogger()
    await installHead({ ...files, "base/apps/web/tsconfig.json": { extends: entry } })

    expect(await baseResolver(logger)("@a", "apps/web/src/page.ts")).toEqual(expected)
    expect(logger.warnings).toEqual([])
  })

  it("does not look in the installed checkout for a config of the workspace's own it lacks", async () => {
    const logger = recordingLogger()
    await installHead({
      "head/tsconfig.base.json": paths({ "@a": ["from-head"] }),
      "base/apps/web/tsconfig.json": { extends: "../../tsconfig.base.json" },
    })

    expect(await baseResolver(logger)("@a", "apps/web/src/page.ts")).toEqual([])
    expect(logger.warnings).toEqual([
      'apps/web/tsconfig.json extends "../../tsconfig.base.json", but no config file was found ' +
        "for it, so the path aliases it would supply are not resolved.",
    ])
  })

  it("reads a linked package's config where the link leads, in either checkout alike", async () => {
    const config = { extends: LINKED }
    const own = paths({ "@a": ["./src/a"] })
    await installHead({
      "head/packages/tsconfig/base.json": own,
      "head/apps/web/tsconfig.json": config,
      "base/packages/tsconfig/base.json": own,
      "base/apps/web/tsconfig.json": config,
    })
    const expected = ["packages/tsconfig/src/a"]

    expect(await resolverAt(join(workspace.root, "head"))("@a", "apps/web/x.ts")).toEqual(expected)
    expect(await baseResolver()("@a", "apps/web/x.ts")).toEqual(expected)
  })

  it("warns once about a linked config that is not JSON, by the name of its sources", async () => {
    const logger = recordingLogger()
    await installHead({
      "head/packages/tsconfig/base.json": "{",
      "head/apps/web/tsconfig.json": { extends: LINKED },
    })

    expect(await resolverAt(join(workspace.root, "head"), logger)("@a", "apps/web/x.ts")).toEqual(
      [],
    )
    expect(logger.warnings).toEqual([
      expect.stringMatching(/^packages\/tsconfig\/base\.json is not valid JSON/),
    ])
  })
})
