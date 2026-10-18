import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { diffOfMove, pairingOutcome } from "./fixtures/scan"

const workspace = useScratchWorkspace("name-signature-pairing")

const accountService = (member: string, params: string, guard: string, call: string) =>
  [
    "export class AccountService {",
    `  ${member}(${params}): Account {`,
    `    if (${guard}) throw new Error("name")`,
    `    return build(${call})`,
    "  }",
    "}",
    "",
  ].join("\n")

describe("diff — pairing a method renamed and moved file on its name and signature", () => {
  it.each([
    [
      "one of four parameters retyped, scoring exactly the threshold",
      "a: string, b: number, c: Date, d: Options",
      [
        "moved+changed AccountService -> AccountService (logic-fingerprint+name-disambiguation)",
        "moved+changed AccountService.createUserAccount -> AccountService.createUserAccountRecord (name-signature)",
      ],
    ],
    [
      "two of four parameters retyped, scoring below it",
      "a: string, b: number, c: Instant, d: Options",
      [
        "added AccountService.createUserAccountRecord",
        "moved+changed AccountService -> AccountService (logic-fingerprint+name-disambiguation)",
        "removed AccountService.createUserAccount",
      ],
    ],
  ])("settles a three-token member that gained a fourth, with %s", async (_, headParams, expected) => {
    const diff = await diffOfMove(
      workspace,
      {
        "src/old.ts": accountService(
          "createUserAccount",
          "a: string, b: number, c: Date, d: boolean",
          "!a",
          "a, b, c, d",
        ),
      },
      {
        "src/new.ts": accountService(
          "createUserAccountRecord",
          headParams,
          "!a || b < 0",
          "a, b, c, d.flag",
        ),
      },
    )
    expect(pairingOutcome(diff)).toEqual(expected)
  })
})
