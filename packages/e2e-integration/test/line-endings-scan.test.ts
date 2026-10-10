import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith, symbolNamed } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

const workspace = useScratchWorkspace("line-endings-scan")

const SOURCE = [
  "export function userQuery(id: string) {",
  "  if (",
  "    !id ||",
  "    id.length > 10",
  '  ) throw new Error("bad id")',
  "  return sql`",
  "    select * from users",
  `    where id = $\{id}`,
  "  `",
  "}",
  "",
  "@Controller({",
  '  path: "users",',
  "})",
  "export class UsersController {",
  "  @Get()",
  "  list(): string[] {",
  "    return []",
  "  }",
  "}",
  "",
].join("\n")

const COVERED = ["userQuery", "UsersController", "UsersController.list"]

async function symbolsSavedWith(terminator: string) {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/q.ts", SOURCE.replaceAll("\n", terminator))
  const result = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })
  return { result, json: JSON.stringify(result.ir.symbols) }
}

describe("scan — line terminators", () => {
  it.each([
    ["CRLF", "\r\n"],
    ["a lone CR", "\r"],
  ])("gives the same Symbols for a file saved with %s as with LF", async (_name, terminator) => {
    const lf = await symbolsSavedWith("\n")
    const other = await symbolsSavedWith(terminator)

    for (const name of COVERED) symbolNamed(lf.result, name)
    expect(lf.json).not.toContain("\\r")
    expect(other.json).toBe(lf.json)
  })
})
