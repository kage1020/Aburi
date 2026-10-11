import { describe, expect, it } from "vitest"
import { receiverHead } from "../src/call-site"

describe("receiverHead", () => {
  it.each([
    ["this.save", "this"],
    ["super.save", "super"],
    ["repo.save", "repo"],
    ["save", "save"],
    [".save", "save"],
    ["", undefined],
  ])("reads the receiver of %j as %j", (target, head) => {
    expect(receiverHead(target)).toBe(head)
  })
})
