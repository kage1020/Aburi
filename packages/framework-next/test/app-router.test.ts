import { describe, expect, it } from "vitest"
import { recognizeAppRouterFile } from "../src/index"

describe("recognizeAppRouterFile", () => {
  it.each([
    ["app/page.tsx", "page"],
    ["app/dashboard/page.tsx", "page"],
    ["apps/web/app/(marketing)/pricing/page.tsx", "page"],
    ["packages/web/app/dashboard/page.jsx", "page"],
    ["app/dashboard/settings/layout.tsx", "layout"],
    ["app/template.tsx", "template"],
    ["app/loading.tsx", "loading"],
    ["app/error.tsx", "error"],
    ["app/not-found.tsx", "not-found"],
    ["app/api/users/route.ts", "route"],
    ["app/api/route.js", "route"],
  ])("recognizes %s as a %s", (path, role) => {
    expect(recognizeAppRouterFile(path)).toEqual({ role })
  })

  it.each([
    ["src/page.tsx", "no app/ segment"],
    ["apps/foo/page.tsx", "`apps` is not `app`"],
    ["app-config/page.tsx", "`app-config` is not `app`"],
    ["src/lib/utils.ts", "not a special file name"],
    ["app/default.tsx", "a special file not covered"],
    ["app/global-error.tsx", "a special file not covered"],
    ["app/Page.tsx", "the base name is case-sensitive"],
    ["app/Layout.tsx", "the base name is case-sensitive"],
    ["app/lib/page.ts.bak", "an unrecognized extension"],
    ["app/page.mdx", "an unrecognized extension"],
    ["src/page.py", "an unrecognized extension"],
    ["app/api/route.tsx", "a route never renders JSX"],
    ["app/api/route.jsx", "a route never renders JSX"],
    ["app\\dashboard\\page.tsx", "separated by backslashes"],
    ["app/page", "no extension"],
    ["app/", "no file name"],
    ["", "empty"],
  ])("returns null for %j — %s", (path) => {
    expect(recognizeAppRouterFile(path)).toBeNull()
  })
})
