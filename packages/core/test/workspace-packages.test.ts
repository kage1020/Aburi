import { join } from "node:path"
import { errorFrom } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CoreError, readWorkspacePackages } from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("workspace-packages")

describe("readWorkspacePackages", () => {
  it("reads the name each root's package.json declares, once per root and in root order", async () => {
    await tree.writeJson("package.json", { name: "acme" })
    await tree.writeJson("packages/web/package.json", { name: "@acme/web" })
    await tree.writeSource("packages/api/package.json", '﻿{ "name": "@acme/api" }')

    const packages = await readWorkspacePackages(tree.root, [
      "packages/web",
      ".",
      "packages/api",
      "packages/web",
    ])

    expect(packages).toEqual([
      { name: "acme", root: "." },
      { name: "@acme/api", root: "packages/api" },
      { name: "@acme/web", root: "packages/web" },
    ])
  })

  it.each([
    ["has no package.json", null],
    ["declares no name", { version: "1.0.0" }],
    ["declares an empty name", { name: "" }],
    ["declares a name that is not a string", { name: 42 }],
    ["is not an object", []],
  ])("leaves out a root whose manifest %s", async (_case, manifest) => {
    if (manifest !== null) await tree.writeJson("packages/web/package.json", manifest)
    await tree.mkdir("packages/web")

    expect(await readWorkspacePackages(tree.root, ["packages/web"])).toEqual([])
  })

  it("refuses a manifest it cannot parse, naming it", async () => {
    await tree.writeSource("packages/web/package.json", "{ name: ")

    const error = await errorFrom(CoreError, () =>
      readWorkspacePackages(tree.root, ["packages/web"]),
    )

    expect(error.code).toBe("workspace-manifest-malformed")
    expect(error.message).toContain(join(tree.root, "packages", "web", "package.json"))
  })
})
