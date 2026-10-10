import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { CliError } from "../src"
import { pathExists, pathKind } from "../src/fs-probe"

const workspace = useScratchWorkspace("fs-probe")

beforeEach(async () => {
  await workspace.writeSource("file.txt", "x")
  await mkdir(resolve(workspace.root, "directory"))
})

describe("pathExists and pathKind", () => {
  it.each([
    ["a file", "file.txt", true, "file"],
    ["a directory", "directory", true, "directory"],
    ["nothing", "absent.txt", false, "nothing"],
    ["a path under a file", "file.txt/below", false, "nothing"],
  ] as const)("answer for %s", async (_, rel, exists, kind) => {
    const path = resolve(workspace.root, rel)
    expect(await pathExists(path)).toBe(exists)
    expect(await pathKind(path)).toBe(kind)
  })

  it.each([
    pathExists,
    pathKind,
  ])("report a probe that failed for any reason but absence, rather than answering absent", async (probe) => {
    const path = resolve(workspace.root, "nul\0byte")

    const error = await errorFrom(CliError, () => probe(path))

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain(`Failed to probe ${path}`)
  })
})
