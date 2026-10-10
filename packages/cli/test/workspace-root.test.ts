import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError } from "../src/errors"
import { resolveWorkspaceRoot } from "../src/workspace-root"

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-workspace-root-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("resolveWorkspaceRoot", () => {
  it("takes the directory itself when nothing around it is a workspace", async () => {
    const bare = resolve(scratch, "loose")
    await mkdir(bare, { recursive: true })

    expect(await resolveWorkspaceRoot(bare)).toBe(bare)
  })

  it("finds the marker above the working directory", async () => {
    await writeFile(resolve(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
    await writeFile(
      resolve(scratch, "package.json"),
      JSON.stringify({ name: "root", private: true }),
      "utf8",
    )
    const app = resolve(scratch, "pkgs/app")
    await mkdir(app, { recursive: true })

    expect(await resolveWorkspaceRoot(app)).toBe(scratch)
  })

  it("refuses a workspace manifest it cannot parse instead of pretending there is none", async () => {
    await writeFile(resolve(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
    const app = resolve(scratch, "pkgs/app")
    await mkdir(app, { recursive: true })
    await writeFile(resolve(app, "package.json"), '{ "name": "app", }', "utf8")

    const thrown = await resolveWorkspaceRoot(app).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("config-error")
    expect((thrown as Error).message).toContain("package.json")
  })
})
