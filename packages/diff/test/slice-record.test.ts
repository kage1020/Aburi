import { call, errorFrom, fp, makeIR, makeSymbol, sliceId, symbolId } from "@aburi/test-support"
import type { SliceRecord } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  assertSliceRecordInvariant,
  DiffError,
  type SliceViolationKind,
  sliceAnchor,
  sliceRecordViolation,
} from "../src"
import { diffOf } from "./helpers"

describe("a SliceRecord the diff emits", () => {
  it("satisfies the derivation invariant", () => {
    const at = (name: string, seed: string, calls: ReturnType<typeof call>[] = []) =>
      makeSymbol({ id: `ts:src/${name}.ts#${name}`, name, fingerprint: fp(seed), calls })
    const diff = diffOf(
      makeIR({ symbols: [at("a", "a"), at("b", "a")] }),
      makeIR({
        symbols: [
          at("a", "b", [call({ target: "b", resolved: "ts:src/b.ts#b" })]),
          at("b", "b"),
          at("z", "b"),
        ],
      }),
    )
    expect(diff.slices.map((slice) => slice.members.length)).toEqual([2, 1])
    for (const slice of diff.slices) {
      expect(sliceRecordViolation(slice)).toBeNull()
      expect(() => assertSliceRecordInvariant(slice)).not.toThrow()
    }
  })
})

describe("sliceAnchor", () => {
  it("answers from members[0], not from the id", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    expect(sliceAnchor({ id: sliceId(`slice:${B}`), members: [symbolId(A), symbolId(B)] })).toBe(A)
  })

  it("throws for an empty members[] rather than answering undefined", async () => {
    const error = await errorFrom(DiffError, () =>
      sliceAnchor({ id: sliceId("slice:ts:src/a.ts#A"), members: [] }),
    )
    expect(error).toMatchObject({ code: "slice-invariant-violated", value: "slice:ts:src/a.ts#A" })
  })
})

describe("a record that breaks the derivation invariant", () => {
  it.each<[string, { id: string; members: string[] }, SliceViolationKind]>([
    [
      "an id that is not its anchor's",
      { id: "slice:ts:src/foo.ts#foo", members: ["ts:src/bar.ts#bar", "ts:src/baz.ts#baz"] },
      "id-not-derived",
    ],
    [
      "an id missing the `slice:` prefix",
      { id: "ts:src/a.ts#A", members: ["ts:src/a.ts#A"] },
      "id-not-derived",
    ],
    [
      "members[] out of order",
      { id: "slice:ts:src/b.ts#B", members: ["ts:src/b.ts#B", "ts:src/a.ts#A"] },
      "members-unordered",
    ],
    [
      "a member listed twice",
      { id: "slice:ts:src/a.ts#A", members: ["ts:src/a.ts#A", "ts:src/a.ts#A"] },
      "members-unordered",
    ],
    ["an empty members[]", { id: "slice:ts:src/a.ts#A", members: [] }, "members-empty"],
    [
      "an anchor in the reserved `slice:` namespace",
      { id: "slice:slice:src/a.ts#A", members: ["slice:src/a.ts#A"] },
      "anchor-in-reserved-namespace",
    ],
  ])("is reported, and thrown with the same message, for %s", async (_, record, kind) => {
    const violation = sliceRecordViolation(record)
    expect(violation).toMatchObject({ kind, subject: record.id })
    expect(
      await errorFrom(DiffError, () => assertSliceRecordInvariant(record as SliceRecord)),
    ).toMatchObject({
      code: "slice-invariant-violated",
      value: record.id,
      message: violation?.message,
    })
  })

  it("does not mistake a language token that merely starts like the reserved one", () => {
    expect(
      sliceRecordViolation({ id: "slice:slicer:src/a.ts#A", members: ["slicer:src/a.ts#A"] }),
    ).toBeNull()
  })
})

describe("a value that is not a SliceRecord at all", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "slice:a"],
    ["an array", []],
    ["a record without members[]", { id: "slice:ts:src/a.ts#A" }],
    ["a record whose members[] is a string", { id: "slice:ts:src/a.ts#A", members: "nope" }],
    ["a record whose members[] is a number", { id: "slice:a", members: 5 }],
    ["a record whose members[] holds a non-string", { id: "slice:a", members: ["a", 7] }],
    ["a record without an id", { members: ["ts:src/a.ts#A"] }],
  ])("is reported as malformed, not thrown on, for %s", (_, value) => {
    expect(sliceRecordViolation(value)?.kind).toBe("malformed-shape")
  })

  it("names a record by its id when it has one, and by a stand-in when it does not", () => {
    expect(sliceRecordViolation({ id: "slice:ts:src/a.ts#A" })?.subject).toBe("slice:ts:src/a.ts#A")
    const anonymous = sliceRecordViolation({ members: ["ts:src/a.ts#A"] })
    expect(anonymous?.subject).toBe("<missing id>")
    expect(anonymous?.message).not.toMatch(/"undefined"/)
  })

  it("says what members[] must be", () => {
    expect(sliceRecordViolation({ id: "slice:a", members: "nope" })?.message).toMatch(
      /array of strings/,
    )
  })
})
