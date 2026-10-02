import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { scanWith } from "../src/scan-helper"
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
  // biome-ignore lint/suspicious/noTemplateCurlyInString: TypeScript source, not a template
  "    where id = ${id}",
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

async function symbolsSavedWith(terminator: string) {
  await workspace.writeSource("package.json", '{"name":"demo","private":true}\n')
  await workspace.writeSource("src/q.ts", SOURCE.replaceAll("\n", terminator))
  const result = await scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })
  return JSON.stringify(result.ir.symbols)
}

describe("scan — line terminators", () => {
  it.each([
    ["CRLF", "\r\n"],
    ["a lone CR", "\r"],
  ])("gives the same Symbols for a file saved with %s as with LF", async (_name, terminator) => {
    const lf = await symbolsSavedWith("\n")
    const other = await symbolsSavedWith(terminator)

    expect(lf).not.toContain("\\r")
    expect(other).toBe(lf)
  })
})
