import { rm } from "node:fs/promises"
import { join } from "node:path"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffIRs, scanWith } from "@aburi/test-harness"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nextFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("route-removal-diff")

const LINEUP = { languages: [langTypescriptPlugin], frameworks: [nextFrameworkPlugin] }

const scanWorkspace = async () => (await scanWith(workspace.root, LINEUP)).ir

const HANDLER = [
  'import { listUsers } from "../../../../lib/users"',
  "export async function GET(request: Request) {",
  '  const token = request.headers.get("authorization")',
  "  if (token === null) return new Response(null, { status: 401 })",
  "  return Response.json(await listUsers(token))",
  "}",
  "",
].join("\n")

describe("diff — a route deleted beside an identical one", () => {
  it("is a removal that names no survivor, since the route lives in its file and not its body", async () => {
    await workspace.writeSource(
      "lib/users.ts",
      "export async function listUsers(token: string) { return [token] }\n",
    )
    await workspace.writeSource("app/api/v1/users/route.ts", HANDLER)
    await workspace.writeSource("app/api/v2/users/route.ts", HANDLER)
    const base = await scanWorkspace()
    await rm(join(workspace.root, "app/api/v1/users/route.ts"))
    const head = await scanWorkspace()

    const diff = diffIRs(base, head)

    expect(diff.symbols).toMatchObject([
      {
        status: "removed",
        symbol: { id: "ts:app/api/v1/users/route.ts#GET", extKind: "framework:next:route" },
        duplicateOf: null,
      },
    ])
    expect(diff.summary).toMatchObject({ removed: 1, removedDuplicates: 0 })
  })
})
