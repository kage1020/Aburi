import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ENTRIES, generateAll, OUT_DIR } from "../scripts/codegen-lib"

describe("schema codegen", () => {
  it("committed generated files match what codegen would produce now", async () => {
    const expected = await generateAll()
    for (const entry of ENTRIES) {
      const path = join(OUT_DIR, entry.out)
      const actual = await readFile(path, "utf8")
      expect(actual, `${entry.out} is out of date. Run: pnpm --filter @aburi/types codegen`).toBe(
        expected[entry.out],
      )
    }
  })

  it("is deterministic (running twice produces identical output)", async () => {
    const a = await generateAll()
    const b = await generateAll()
    expect(b).toEqual(a)
  })
})
