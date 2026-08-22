import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { describeThrown, errorCode, isVanishedFile } from "../../src/scan/faults"

/**
 * The predicate is asserted against errno values the operating system actually produced,
 * not against object literals carrying a `code`. A literal would pass whatever the real
 * syscall does, which is the only thing the two scan stages ever see — and the codes are
 * not the same on every platform: replacing a directory with a file answers `ENOTDIR` on
 * POSIX and `ENOENT` on Windows, which is why the predicate holds two codes rather than one.
 */
let workRoot: string

/** The failure a syscall raised, or a throw naming the call that was supposed to fail. */
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
  // Readable-but-not-traversable is also not deletable, so the mode goes back before the
  // tree does.
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
    // The same event as a deletion — something replaced part of the path while the scan
    // held a listing of it — reported under a different code, and under a different code
    // again depending on the platform.
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

  it("refuses a thrown value that carries no code at all", () => {
    expect(isVanishedFile(new Error("ENOENT: no such file or directory"))).toBe(false)
    expect(isVanishedFile("ENOENT")).toBe(false)
    expect(isVanishedFile(null)).toBe(false)
  })
})

describe("errorCode", () => {
  it("reads a string code and nothing else", () => {
    expect(errorCode({ code: "EACCES" })).toBe("EACCES")
    expect(errorCode({ code: 13 })).toBeNull()
    expect(errorCode(null)).toBeNull()
    expect(errorCode("EACCES")).toBeNull()
  })
})

describe("describeThrown", () => {
  it("takes an Error's message", () => {
    expect(describeThrown(new Error("boom"))).toBe("boom")
  })

  it("names the class of an Error nobody gave a message", () => {
    expect(describeThrown(new Error(""))).toBe("Error")
  })

  it("says a string was thrown when the string is empty", () => {
    // The value this function exists to replace. Recorded as "" it is indistinguishable
    // from a detail nobody wrote, which is the silence the per-file boundary is for.
    const described = describeThrown("")
    expect(described).not.toBe("")
    expect(described).toContain("string")
  })

  it("says an object was thrown when the object describes itself as nothing", () => {
    // Not the empty-string branch: this one reaches the end of the chain and comes back
    // empty anyway, so the guard has to be on the result rather than on the branch.
    const described = describeThrown({ toJSON: () => undefined, toString: () => "" })
    expect(described).not.toBe("")
    expect(described).toContain("object")
  })

  it("serializes a plain object", () => {
    expect(describeThrown({ reason: "refused" })).toBe('{"reason":"refused"}')
  })

  it("returns something for every value a plugin can throw", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const thrown: unknown[] = [
      "",
      "plain",
      undefined,
      null,
      0,
      Number.NaN,
      false,
      1n,
      Symbol("s"),
      new Error(""),
      new Error("boom"),
      circular,
      Object.create(null),
      { toJSON: () => undefined, toString: () => "" },
      { toJSON: () => 1n },
      [],
    ]
    for (const value of thrown) {
      expect(describeThrown(value), `describing a ${typeof value}`).not.toBe("")
    }
  })
})
