import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith, symbolNamed } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * The same source saved with LF, CRLF or a lone CR is the same program, and its Document must
 * not say otherwise: a template literal's line break reached the `syntax` fingerprint as the
 * characters `\r\n`, a guard's `condition` and a decorator's `raw` kept the `\r`, and a CR-only
 * file read as one line (fingerprint.md §5.3).
 */

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

/**
 * What the fixture is written for: `userQuery` holds the template literal and the guard, and
 * the class and its route hold the decorators.
 */
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

    // Two empty lists are equal and hold no `\r`, so the Symbols are pinned before either
    // comparison; the equality then carries them to the other side.
    for (const name of COVERED) symbolNamed(lf.result, name)
    expect(lf.json).not.toContain("\\r")
    expect(other.json).toBe(lf.json)
  })
})
