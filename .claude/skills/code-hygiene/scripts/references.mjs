// List comments and test titles that cite something that rots: design-doc sections (§3.4, foo.md),
// spec ids (CR5, LP8q, DF12), invariant numbers and issue / pull-request numbers.
//
//   node .claude/skills/code-hygiene/scripts/references.mjs [globs…]
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

const ts = createRequire(join(process.cwd(), "package.json"))("typescript")

const REFERENCE =
  /§|(^|[^&\w/])#\d+\b|\bthe issue\b|\b(?:LP|LE|MP|DF|CR|EP|CS|CL|SV|PR|NF|CD)\d+[a-z]?\b|\binvariant\s*#?\d+|\b[\w-]+-[\w-]+\.md\b/

const patterns = process.argv.slice(2)
const files = execFileSync(
  "git",
  ["ls-files", ...(patterns.length > 0 ? patterns : ["*.ts", "*.tsx", "*.mts", "*.mjs"])],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(
    (file) =>
      file &&
      existsSync(file) &&
      !file.startsWith(".claude/") &&
      !file.includes("/generated/") &&
      !/\/(projects|before|after)\//.test(file),
  )

function kindFor(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (/\.(m|c)?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function calleeName(node) {
  let callee = node.expression
  while (ts.isCallExpression(callee)) callee = callee.expression
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression
  return ts.isIdentifier(callee) ? callee.text : null
}

let hits = 0
for (const file of files) {
  const text = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindFor(file))
  const seen = new Set()
  const report = (pos, what, body) => {
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1
    console.log(`${file}:${line} ${what}: ${body.replace(/\s+/g, " ").slice(0, 140)}`)
    hits++
  }
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) return
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ]) {
      if (seen.has(range.pos)) continue
      seen.add(range.pos)
      const body = text.slice(range.pos, range.end)
      if (REFERENCE.test(body)) report(range.pos, "comment", body)
    }
    if (ts.isCallExpression(node) && ["describe", "it", "test"].includes(calleeName(node))) {
      const title = node.arguments[0]
      if (title && ts.isStringLiteralLike(title) && REFERENCE.test(title.text)) {
        report(title.getStart(sf), "title", title.text)
      }
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
}
console.log(`\n${hits} reference(s) in ${files.length} file(s)`)
process.exitCode = hits === 0 ? 0 : 1
