import { describe, expect, it } from "vitest"
import { recognizeAppRouterFile } from "../src/index"

describe("recognizeAppRouterFile — App Router special files", () => {
  it.each([
    ["app/page.tsx", "page"],
    ["app/dashboard/page.tsx", "page"],
    ["apps/web/app/(marketing)/pricing/page.tsx", "page"],
    ["app/layout.tsx", "layout"],
    ["app/dashboard/settings/layout.tsx", "layout"],
    ["app/template.tsx", "template"],
    ["app/loading.tsx", "loading"],
    ["app/error.tsx", "error"],
    ["app/not-found.tsx", "not-found"],
    ["app/api/users/route.ts", "route"],
    ["packages/web/app/dashboard/page.jsx", "page"],
  ])("recognizes %s as %s", (path, role) => {
    const result = recognizeAppRouterFile(path)
    expect(result?.role).toBe(role)
    expect(result?.isRoute).toBe(role === "route")
  })

  it.each([
    "src/page.tsx", // No app/ segment
    "src/lib/utils.ts", // Not a special filename
    "app/lib/page.ts.bak", // Unrecognized extension
    "app/page.mdx", // Unrecognized extension
    "src/page.py", // Wrong language
    "app-config/page.tsx", // Not the actual app/ directory (no `app` segment in parents)
    "app/", // No filename
    "", // Empty path
    "app/page", // Missing extension
  ])("returns null for %s (not an App Router file)", (path) => {
    expect(recognizeAppRouterFile(path)).toBeNull()
  })

  it("returns null for a file whose parent chain has `app` as part of a longer segment", () => {
    // `apps/foo/page.tsx` should not match — `apps` is not the App Router directory.
    expect(recognizeAppRouterFile("apps/foo/page.tsx")).toBeNull()
  })

  it("isRoute is true only for `route.ts` / `route.js`", () => {
    expect(recognizeAppRouterFile("app/api/route.ts")?.isRoute).toBe(true)
    expect(recognizeAppRouterFile("app/api/route.js")?.isRoute).toBe(true)
    expect(recognizeAppRouterFile("app/dashboard/page.tsx")?.isRoute).toBe(false)
  })
})
