import { recordingLogger } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffSymbols, fn, method } from "./helpers"

function tracedBy(base: readonly IRSymbol[], head: readonly IRSymbol[]) {
  const logger = recordingLogger()
  const diff = diffSymbols(base, head, { logger })
  return { diff, lines: logger.debugs.map((line) => line.message) }
}

const notCompared = (id: string, why: string) =>
  `diff/stage4: ts:${id} is not compared by name: ${why}`
const SAYS_TOO_LITTLE = "its name says too little to pair on"
const NO_SIGNATURE = "it has no signature, and a name alone does not pair"

describe("stage 4 says why it left a Symbol out", () => {
  it.each([
    [
      "a name that says too little",
      fn("src/a.ts", "render", "a"),
      fn("src/b.ts", "render", "b"),
      [
        notCompared("src/a.ts#render", SAYS_TOO_LITTLE),
        notCompared("src/b.ts#render", SAYS_TOO_LITTLE),
      ],
    ],
    [
      "no signature",
      fn("src/a.ts", "buildConfig", "a", { kind: "const", signature: null }),
      fn("src/b.ts", "buildConfig", "b", { kind: "const", signature: null }),
      [
        notCompared("src/a.ts#buildConfig", NO_SIGNATURE),
        notCompared("src/b.ts#buildConfig", NO_SIGNATURE),
      ],
    ],
  ])("for %s, on both sides", (_label, base, head, lines) => {
    const traced = tracedBy([base], [head])

    expect(traced.diff.summary).toMatchObject({ added: 1, removed: 1 })
    expect(traced.lines).toEqual(lines)
  })

  it("names the pairing the owner gate refused", () => {
    const traced = tracedBy(
      [method("src/a.ts", "UserRepo.findUser", "a")],
      [method("src/b.ts", "UsersRepository.findUser", "b")],
    )

    expect(traced.diff.summary).toMatchObject({ added: 1, removed: 1 })
    expect(traced.lines).toEqual([
      "diff/stage4: ts:src/a.ts#UserRepo.findUser and ts:src/b.ts#UsersRepository.findUser are not paired: their owners do not correspond",
    ])
  })
})

describe("stage 4 traces nothing it decided on a score", () => {
  it.each([
    [
      "a pairing it made",
      method("src/a.ts", "UserRepo.findUser", "a"),
      method("src/b.ts", "UserRepos.findUser", "b"),
    ],
    [
      "a pair whose names score below the bar",
      fn("src/a.ts", "findUser", "a"),
      fn("src/b.ts", "listOrders", "b"),
    ],
  ])("for %s", (_label, base, head) => {
    expect(tracedBy([base], [head]).lines).toEqual([])
  })
})
