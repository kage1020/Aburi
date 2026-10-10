import { errorFrom } from "@aburi/test-support"
import type { Component } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  __testing_component,
  CoreError,
  detectComponents,
  makeComponentId,
  makeLanguageId,
} from "../src/index"
import { useWorkspaceTree } from "./fixtures/workspace"

const tree = useWorkspaceTree("core-component-id")

async function rootsToIds(): Promise<string[]> {
  const components = await detectComponents({ workspaceRoot: tree.root })
  return components.map((c) => `${c.roots[0]}=${c.id}`)
}

async function writePackages(packages: Record<string, Record<string, unknown>>): Promise<void> {
  for (const [dir, manifest] of Object.entries(packages)) await tree.writePackage(dir, manifest)
}

describe("the id a package name yields", () => {
  it.each<[string, string | null]>([
    ["billing", "billing"],
    ["@scope/billing", "scope-billing"],
    ["@scope/", null],
    ["@scope", null],
    ["", null],
    ["@acme/---", ""],
    ["@acme/___", ""],
    ["@acme/日本語", ""],
  ])("%j yields %j", (name, id) => {
    expect(__testing_component.toIdFromNpmName(name)).toBe(id)
  })

  it.each([
    ["BillingApi", "billing-api"],
    ["billing_api v2", "billing-api-v2"],
    ["--billing--", "billing"],
    ["Ünïcode", "n-code"],
  ])("kebab-cases %j as %j", (input, kebab) => {
    expect(__testing_component.toKebabCase(input)).toBe(kebab)
  })

  it("accepts a digit-leading package name, which npm allows", async () => {
    await tree.writePnpmWorkspace("packages/*")
    await writePackages({
      "packages/3d-renderer": { name: "3d-renderer" },
      "packages/7zip-bin": { name: "7zip-bin" },
    })

    expect(await rootsToIds()).toEqual([
      "packages/3d-renderer=3d-renderer",
      "packages/7zip-bin=7zip-bin",
    ])
  })

  it.each([
    "@acme/---",
    "---",
  ])("aborts naming the package and its root when %j cannot yield an id", async (name) => {
    await tree.writePnpmWorkspace("packages/*")
    await tree.writePackage("packages/widgets", { name })

    const error = await errorFrom(CoreError, () => detectComponents({ workspaceRoot: tree.root }))

    expect(error.code).toBe("invalid-component-id")
    expect(error.message).toContain(`package name "${name}"`)
    expect(error.message).toContain("packages/widgets")
  })
})

describe("colliding ids", () => {
  it.each<[string, string[], Record<string, Record<string, unknown>>, string[]]>([
    [
      "takes the parent directory as a suffix",
      ["apps/*", "libs/*"],
      { "apps/shared": { name: "shared" }, "libs/shared": { name: "shared" } },
      ["apps/shared=shared-apps", "libs/shared=shared-libs"],
    ],
    [
      "takes one more step up past a parent they share",
      ["team1/*/*", "team2/*/*"],
      { "team1/shared/pkg": { name: "pkg" }, "team2/shared/pkg": { name: "pkg" } },
      ["team1/shared/pkg=pkg-shared-team1", "team2/shared/pkg=pkg-shared-team2"],
    ],
    [
      "separates three on the path, not with a counter",
      ["a/*/*", "b/*/*", "c/*/*"],
      {
        "a/shared/pkg": { name: "pkg" },
        "b/shared/pkg": { name: "pkg" },
        "c/shared/pkg": { name: "pkg" },
      },
      ["a/shared/pkg=pkg-shared-a", "b/shared/pkg=pkg-shared-b", "c/shared/pkg=pkg-shared-c"],
    ],
    [
      "falls back to a root hash when no ancestor segment can form a suffix",
      ["**/app"],
      { "--/app": {}, "---/app": {} },
      ["---/app=app-74a714d5", "--/app=app-d2408cdb"],
    ],
    [
      "never arise between scoped names, which fold the scope in",
      ["packages/*"],
      {
        "packages/a-utils": { name: "@alpha/utils" },
        "packages/b-utils": { name: "@beta/utils" },
        "packages/c-utils": { name: "@gamma/utils" },
      },
      [
        "packages/a-utils=alpha-utils",
        "packages/b-utils=beta-utils",
        "packages/c-utils=gamma-utils",
      ],
    ],
  ])("%s", async (_case, patterns, packages, expected) => {
    await tree.writePnpmWorkspace(...patterns)
    await writePackages(packages)

    expect(await rootsToIds()).toEqual(expected)
  })

  it("keeps colliding siblings' ids where they were when one more is added", async () => {
    await tree.writePnpmWorkspace("packages/*")
    await writePackages({
      "packages/a-utils": { name: "utils" },
      "packages/b-utils": { name: "utils" },
      "packages/c-utils": { name: "utils" },
    })
    const before = await rootsToIds()
    expect(before).toEqual([
      "packages/b-utils=utils-packages-446c5bf9",
      "packages/a-utils=utils-packages-b9b98f98",
      "packages/c-utils=utils-packages-d48cea54",
    ])

    await tree.writePackage("packages/d-utils", { name: "utils" })

    const after = await rootsToIds()
    expect(after).toHaveLength(4)
    expect(after).toEqual(expect.arrayContaining(before))
    expect(after).toContain("packages/d-utils=utils-packages-539ec16f")
  })

  it("moves the component whose id a newcomer claims, and only that one", async () => {
    await tree.writePnpmWorkspace("team/*/shared", "packages/*")
    await writePackages({
      "team/apps/shared": { name: "shared" },
      "team/libs/shared": { name: "shared" },
    })
    expect(await rootsToIds()).toEqual([
      "team/apps/shared=shared-apps",
      "team/libs/shared=shared-libs",
    ])

    await tree.writePackage("packages/x", { name: "shared-libs" })

    expect(await rootsToIds()).toEqual([
      "team/apps/shared=shared-apps",
      "packages/x=shared-libs-packages",
      "team/libs/shared=shared-libs-team",
    ])
  })

  it("refuses to hand back a duplicate id rather than letting `aburi init` write one", () => {
    const app = (): Component => ({
      id: makeComponentId("app"),
      name: "app",
      roots: ["packages/app"],
      languages: [makeLanguageId("ts")],
      description: null,
    })

    expect(() => __testing_component.resolveIdCollisions([app(), app()])).toThrowError(
      expect.objectContaining({ code: "component-id-collision-unresolved" }),
    )
  })
})
