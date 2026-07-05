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

  it("role === 'route' only for `route.ts` / `route.js`", () => {
    expect(recognizeAppRouterFile("app/api/route.ts")?.role).toBe("route")
    expect(recognizeAppRouterFile("app/api/route.js")?.role).toBe("route")
    expect(recognizeAppRouterFile("app/api/route.tsx")).toBeNull()
    expect(recognizeAppRouterFile("app/api/route.jsx")).toBeNull()
    expect(recognizeAppRouterFile("app/dashboard/page.tsx")?.role).toBe("page")
  })

  it("base name is case-sensitive (Page.tsx is a colocated component, not a page)", () => {
    expect(recognizeAppRouterFile("app/Page.tsx")).toBeNull()
    expect(recognizeAppRouterFile("app/PAGE.tsx")).toBeNull()
    expect(recognizeAppRouterFile("app/Layout.tsx")).toBeNull()
  })

  it("backslash-separated paths are rejected (POSIX-only, matches Symbol.id contract)", () => {
    expect(recognizeAppRouterFile("app\\dashboard\\page.tsx")).toBeNull()
  })
})
