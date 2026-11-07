import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { diffOfMove, pairingOutcome } from "./fixtures/scan"

const workspace = useScratchWorkspace("owner-pairing")

const invoice = [
  "export class Invoice {",
  "  render(t: number) {",
  "    return t.toFixed(2)",
  "  }",
  "}",
  "",
].join("\n")

const repo = (owner: string) =>
  [
    `export class ${owner} {`,
    "  getUser(id: string): User {",
    "    return db.find(id)",
    "  }",
    "  save(user: User): void {",
    "    db.write(user)",
    "  }",
    "}",
    "",
  ].join("\n")

describe("diff — a class paired with the class its methods moved into", () => {
  it("reports a one-word class that moved file unchanged as one move, beside its method's", async () => {
    const diff = await diffOfMove(workspace, { "src/old.ts": invoice }, { "src/new.ts": invoice })

    expect(pairingOutcome(diff)).toEqual([
      "moved Invoice -> Invoice (name-signature through 1)",
      "moved Invoice.render -> Invoice.render (logic-fingerprint+name-disambiguation)",
    ])
    expect(diff.summary).toMatchObject({ added: 0, removed: 0 })
  })

  it("reports a class pluralised in place as a renamed pair, beside the call-only class next to it", async () => {
    const audit = "export class Audit {\n  log(): void {\n    audit()\n  }\n}\n"
    const diff = await diffOfMove(
      workspace,
      { "src/repo.ts": `${repo("UserRepo")}${audit}` },
      { "src/repo.ts": `${repo("UsersRepo")}${audit}` },
    )

    expect(pairingOutcome(diff)).toEqual([
      "moved UserRepo.getUser -> UsersRepo.getUser (name-signature)",
      "moved UserRepo.save -> UsersRepo.save (name-signature)",
      "moved+changed UserRepo -> UsersRepo (name-signature through 2)",
    ])
  })

  it("leaves a class added and removed when its method moved into another class", async () => {
    const diff = await diffOfMove(
      workspace,
      { "src/old.ts": invoice },
      { "src/new.ts": invoice.replace("class Invoice", "class Receipt") },
    )

    expect(pairingOutcome(diff)).toEqual([
      "added Receipt",
      "added Receipt.render",
      "removed Invoice",
      "removed Invoice.render",
    ])
  })
})
