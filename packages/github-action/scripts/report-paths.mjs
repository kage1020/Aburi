import { statSync } from "node:fs"
import { resolve } from "node:path"

const DIFF_JSON = "diff.json"
const DIFF_MD = "diff.md"

const outputDir = process.env.OUTPUT_DIR ?? ""
const format = process.env.FORMAT || "both"

function written(requested, name) {
  if (!requested) return ""
  const path = resolve(process.cwd(), outputDir, name)
  return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : ""
}

const json = written(format === "json" || format === "both", DIFF_JSON)
const md = written(format === "md" || format === "both", DIFF_MD)
process.stdout.write(`diff-json-path=${json}\ndiff-md-path=${md}\n`)
