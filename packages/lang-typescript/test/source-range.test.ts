import { describe, expect, it } from "vitest"
import { symbolsOf } from "./fixtures/ctx"

describe("a Symbol's source range", () => {
  it("writes both column keys, as null, for declarations and registrations alike", async () => {
    const symbols = await symbolsOf(
      [
        "export function createInvoice() {}",
        "export class InvoiceService {",
        "  createInvoice() {}",
        "  static fromJson() {}",
        "}",
        "export interface Invoice { id: string }",
        "export type Money = number",
        "export enum Status { Draft }",
        "app.get('/users', h)",
        "app.use(mw)",
      ].join("\n"),
    )

    expect(symbols.filter((s) => s.kind === "call")).toHaveLength(2)
    for (const { source } of symbols) {
      expect(source).toHaveProperty("startColumn", null)
      expect(source).toHaveProperty("endColumn", null)
    }
  })
})
