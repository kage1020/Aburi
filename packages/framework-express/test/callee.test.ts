import { describe, expect, it } from "vitest"
import { calleeRoot } from "../src/index"

describe("calleeRoot", () => {
  it.each([
    ["app", "app"],
    ["app.get", "app"],
    ["router.route.get", "router"],
    ["app.route('/x').get", "app"],
    ["factory(x).get", "factory"],
  ])("reads %s as rooted at %s", (callee, root) => {
    expect(calleeRoot(callee)).toBe(root)
  })
})
