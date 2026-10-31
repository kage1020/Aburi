import { recordingLogger, sig } from "@aburi/test-support"
import type { Symbol as IRSymbol, Summary } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { diffSymbols, dropped, fn, method } from "./helpers"

function tracedBy(base: readonly IRSymbol[], head: readonly IRSymbol[]) {
  const logger = recordingLogger()
  const diff = diffSymbols(base, head, { logger })
  expect(diff).toEqual(diffSymbols(base, head))
  return { diff, lines: logger.debugs.map((line) => line.message) }
}

const notCompared = (id: string, why: string) =>
  `diff/stage4: ts:${id} is not compared by name: ${why}`
const notPaired = (baseId: string, headId: string) =>
  `diff/stage4: ts:${baseId} and ts:${headId} are not paired: their owners do not correspond`
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
    [
      "a name that says too little and no signature",
      fn("src/a.ts", "render", "a", { signature: null }),
      fn("src/b.ts", "render", "b", { signature: null }),
      [
        notCompared("src/a.ts#render", SAYS_TOO_LITTLE),
        notCompared("src/b.ts#render", SAYS_TOO_LITTLE),
      ],
    ],
  ])("for %s, on both sides", (_label, base, head, lines) => {
    const traced = tracedBy([base], [head])

    expect(traced.diff.summary).toMatchObject({ added: 1, removed: 1 })
    expect(traced.lines).toEqual(lines)
  })

  it.each([
    ["reaching the whole bucket", []],
    [
      "walking the token index",
      [method("src/a.ts", "Other.listOrders", "c"), method("src/a.ts", "Other.saveInvoice", "d")],
    ],
  ])("names the pairing the owner gate refused, the head %s", (_label, others) => {
    const traced = tracedBy(
      [method("src/a.ts", "UserRepo.findUser", "a"), ...others],
      [method("src/b.ts", "UsersRepository.findUser", "b")],
    )

    expect(traced.diff.summary).toMatchObject({ added: 1, removed: 1 + others.length })
    expect(traced.lines).toEqual([
      notPaired("src/a.ts#UserRepo.findUser", "src/b.ts#UsersRepository.findUser"),
    ])
  })
})

const CONTROLLERS = ["User", "Order", "Product", "Invoice", "Payment"]

describe("stage 4 traces nothing it decided on a score, or that a pairing settled", () => {
  it.each<[string, IRSymbol[], IRSymbol[], Partial<Summary>]>([
    [
      "a pairing it made",
      [method("src/a.ts", "UserRepo.findUser", "a")],
      [method("src/b.ts", "UserRepos.findUser", "b")],
      { movedChanged: 1, added: 0, removed: 0 },
    ],
    [
      "five classes moved together, each method pairing with its own",
      CONTROLLERS.map((owner, i) => method("src/a.ts", `${owner}Controller.findOne`, `a${i}`)),
      CONTROLLERS.map((owner, i) => method("src/b.ts", `${owner}Controller.findOne`, `b${i}`)),
      { movedChanged: 5, added: 0, removed: 0 },
    ],
    [
      "a base the gate would refuse whose head paired elsewhere",
      [method("src/a.ts", "UserRepo.findUser", "a"), method("src/a.ts", "AdminRepo.findUser", "c")],
      [method("src/b.ts", "UserRepo.findUser", "b")],
      { movedChanged: 1, added: 0, removed: 1 },
    ],
    [
      "a head the gate would refuse whose base paired elsewhere",
      [method("src/a.ts", "UserRepo.findUser", "a")],
      [method("src/b.ts", "UserRepo.findUser", "b"), method("src/b.ts", "AdminRepo.findUser", "c")],
      { movedChanged: 1, added: 1, removed: 0 },
    ],
    [
      "a pair the gate would refuse that scores below its row",
      [method("src/a.ts", "UserRepo.findUser", "a")],
      [
        method("src/b.ts", "AdminRepo.findUser", "b", {
          signature: sig({ inputs: [{ name: "id", type: "number" }], outputs: ["User"] }),
        }),
      ],
      { added: 1, removed: 1 },
    ],
    [
      "a dropped Symbol, whose name says too little",
      [dropped("src/a.ts", "render")],
      [dropped("src/b.ts", "render")],
      {},
    ],
  ])("for %s", (_label, base, head, summary) => {
    const traced = tracedBy(base, head)

    expect(traced.diff.summary).toMatchObject(summary)
    expect(traced.lines).toEqual([])
  })
})
