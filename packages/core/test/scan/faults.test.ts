import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { describeJsonType, describeThrown, errorCode, isVanishedFile } from "../../src/scan/faults"

let workRoot: string

async function statFailure(path: string): Promise<unknown> {
  const outcome = await stat(path).then(
    () => null,
    (error: unknown) => ({ error }),
  )
  if (outcome === null) throw new Error(`stat("${path}") was supposed to fail and did not`)
  return outcome.error
}

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-scan-faults-"))
  await writeFile(join(workRoot, "a-file"), "a", "utf8")
  await mkdir(join(workRoot, "sealed"))
  await writeFile(join(workRoot, "sealed", "inside"), "inside", "utf8")
})

afterAll(async () => {
  await chmod(join(workRoot, "sealed"), 0o755).catch(() => {})
  await rm(workRoot, { recursive: true, force: true })
})

const onUnprivilegedPosix = it.skipIf(process.platform === "win32" || process.getuid?.() === 0)

describe("isVanishedFile", () => {
  it("absorbs a path that is not there", async () => {
    const error = await statFailure(join(workRoot, "never-written"))
    expect(errorCode(error)).toBe("ENOENT")
    expect(isVanishedFile(error)).toBe(true)
  })

  it("absorbs a path whose directory is no longer one", async () => {
    const error = await statFailure(join(workRoot, "a-file", "inner.ts"))
    expect(errorCode(error)).toBe(process.platform === "win32" ? "ENOENT" : "ENOTDIR")
    expect(isVanishedFile(error)).toBe(true)
  })

  onUnprivilegedPosix("refuses a permission failure, which is the machine's", async () => {
    await chmod(join(workRoot, "sealed"), 0o444)
    const error = await statFailure(join(workRoot, "sealed", "inside"))
    await chmod(join(workRoot, "sealed"), 0o755)
    expect(errorCode(error)).toBe("EACCES")
    expect(isVanishedFile(error)).toBe(false)
  })

  it.each([
    new Error("ENOENT: no such file or directory"),
    "ENOENT",
    null,
  ])("refuses %s, which carries no code", (thrown) => {
    expect(isVanishedFile(thrown)).toBe(false)
  })
})

describe("errorCode", () => {
  it.each<[unknown, string | null]>([
    [{ code: "EACCES" }, "EACCES"],
    [{ code: 13 }, null],
    [null, null],
    ["EACCES", null],
  ])("reads %o as %s", (thrown, code) => {
    expect(errorCode(thrown)).toBe(code)
  })
})

describe("describeThrown", () => {
  const circularWithoutPrototype: Record<string, unknown> = Object.create(null)
  circularWithoutPrototype.self = circularWithoutPrototype

  it.each<[string, unknown, string]>([
    ["an Error by its message", new Error("boom"), "boom"],
    ["an Error nobody gave a message by its class", new Error(""), "Error"],
    ["a subclass nobody gave a message", new (class Abort extends Error {})(), "Error"],
    ["a string as itself", "plain", "plain"],
    ["an empty string by its type", "", "a thrown string described itself as empty"],
    ["a plain object as JSON", { reason: "refused", at: 7 }, '{"reason":"refused","at":7}'],
    ["an array as JSON", [], "[]"],
    [
      "an object that describes itself as nothing by its type",
      { toJSON: () => undefined, toString: () => "" },
      "a thrown object described itself as empty",
    ],
    ["an object JSON cannot hold", { toJSON: () => 1n }, "[object Object]"],
    ["a circular object with no prototype", circularWithoutPrototype, "[object Object]"],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a number", Number.NaN, "NaN"],
    ["a boolean", false, "false"],
    ["a bigint", 1n, "1"],
    ["a symbol", Symbol("s"), "Symbol(s)"],
  ])("describes %s", (_label, thrown, described) => {
    expect(describeThrown(thrown)).toBe(described)
  })
})

describe("describeJsonType", () => {
  it.each<[unknown, string]>([
    [[], "a list"],
    [null, "null"],
    [{}, "an object"],
    ["x", "a string"],
    [1, "a number"],
    [true, "a boolean"],
  ])("names %o %s", (value, described) => {
    expect(describeJsonType(value)).toBe(described)
  })
})
