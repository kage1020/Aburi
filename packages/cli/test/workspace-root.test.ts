import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError } from "../src/errors"
import { resolveWorkspaceRoot } from "../src/workspace-root"

/**
 * One failure is absorbed here and the rest are not, and the difference used to be invisible:
 * both commands wrote `catch { return resolve(cwd) }`, so a workspace that exists and cannot be
 * read became "there is no workspace" — silently, and with different consequences in each
 * command.
 */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-workspace-root-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("resolveWorkspaceRoot", () => {
  it("takes the directory itself when nothing around it is a workspace", async () => {
    // A bare folder is a supported thing to scan, and must not need a `package.json` first.
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
    // A conflict marker or a trailing comma is enough. Absorbed, it makes the package the
    // workspace root, every Symbol id is rooted there instead of at the repository, and the
    // next diff against a normal run reads the rest of the monorepo as removed.
    await writeFile(resolve(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
    const app = resolve(scratch, "pkgs/app")
    await mkdir(app, { recursive: true })
    // The detector reads a `package.json` to ask whether it declares workspaces, so a broken
    // one anywhere on the way up stops the walk — including in the package the caller stands in.
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
