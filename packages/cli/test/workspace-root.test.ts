import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError } from "../src"
import { resolveWorkspaceRoot } from "../src/workspace-root"
import { writeMonorepo } from "./workspace"

const workspace = useScratchWorkspace("workspace-root")

describe("resolveWorkspaceRoot", () => {
  it("takes the directory itself when nothing around it is a workspace", async () => {
    const loose = resolve(workspace.root, "loose")
    await mkdir(loose)

    expect(await resolveWorkspaceRoot(loose)).toBe(loose)
  })

  it("finds the marker above the working directory", async () => {
    const app = await writeMonorepo(workspace.root)

    expect(await resolveWorkspaceRoot(app)).toBe(workspace.root)
  })

  it("refuses a workspace manifest it cannot parse instead of pretending there is none", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", "packages:\n  - 'pkgs/*'\n")
    await workspace.writeSource("pkgs/app/package.json", '{ "name": "app", }')

    const error = await errorFrom(CliError, () =>
      resolveWorkspaceRoot(resolve(workspace.root, "pkgs/app")),
    )

    expect(error.code).toBe("config-error")
    expect(error.message).toContain("package.json")
  })
})
