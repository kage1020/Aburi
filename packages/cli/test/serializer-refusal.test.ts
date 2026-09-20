import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runDiff, runScan } from "../src"
import { CliError } from "../src/errors"
import { emptyIR, writeTypeScriptWorkspace } from "./fixtures"

/**
 * The serializer is a separate step from the write, so that a document it refuses (two keys
 * differing only in Unicode composition, `canonical-key-collision`) is exit 2 and says
 * `serialize`, while a disk refusing the bytes is exit 1 and says `write`. Nothing a workspace
 * holds reaches the refusal for real — discovery withdraws file names that collide under NFC
 * before a Symbol is made of them — so the serializer is stood in for here, which is the only
 * way to pin which side of the split each failure lands on.
 */

const REFUSAL = "serializeCanonical at $.symbols[0]: keys render identically after NFC"

vi.mock("@aburi/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@aburi/core")>()
  return {
    ...core,
    serializeCanonical: () => {
      throw new core.CoreError(REFUSAL, { code: "canonical-key-collision" })
    },
  }
})

vi.mock("@aburi/diff", async (importOriginal) => {
  const diff = await importOriginal<typeof import("@aburi/diff")>()
  return {
    ...diff,
    writeCanonicalDiff: () => {
      throw new Error(REFUSAL)
    },
  }
})

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-serializer-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function failure(run: Promise<unknown>): Promise<CliError> {
  const thrown = await run.then(
    () => null,
    (error: unknown) => error,
  )
  expect(thrown).toBeInstanceOf(CliError)
  return thrown as CliError
}

describe("a document the serializer refuses", () => {
  it("is aburi scan's input error, naming the IR path and the refusal", async () => {
    await writeTypeScriptWorkspace(scratch, "serializer-fixture")

    const error = await failure(runScan({ cwd: scratch, format: "json" }))

    expect(error.code).toBe("config-error")
    expect(error.message).toContain(`Failed to serialize the IR for ${resolve(scratch, "out")}`)
    expect(error.message).toContain(REFUSAL)
    expect(error.message).not.toContain("could not write")
  })

  it("is aburi diff's input error the same way", async () => {
    const base = resolve(scratch, "base.json")
    const head = resolve(scratch, "head.json")
    await writeFile(base, JSON.stringify(emptyIR()), "utf8")
    await writeFile(head, JSON.stringify(emptyIR()), "utf8")

    const error = await failure(runDiff({ cwd: scratch, base, head, format: "json" }))

    expect(error.code).toBe("config-error")
    expect(error.message).toContain(`Failed to serialize the diff for ${resolve(scratch, "out")}`)
    expect(error.message).toContain(REFUSAL)
    expect(error.message).not.toContain("could not write")
  })
})
