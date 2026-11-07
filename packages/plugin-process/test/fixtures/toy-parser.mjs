// A parser for a toy language, run as its own process the way one written in Python or Go would be.
//   def <name>        starts a function, which runs to the next def
//     call <target>   is a call in it
//   !crash            ends the parser as it reads the file
import { createInterface } from "node:readline"

function parse({ content }) {
  const functions = []
  content.split("\n").forEach((text, index) => {
    const line = index + 1
    const def = /^def (\w+)$/.exec(text)
    const call = /^ {2}call (\w+)$/.exec(text)
    if (text === "!crash") process.exit(70)
    if (def !== null)
      functions.push({ name: def[1], startLine: line, endLine: line, text, calls: [] })
    const current = functions.at(-1)
    if (current === undefined) return
    if (call !== null) current.calls.push({ target: call[1], line })
    if (def === null && text.length > 0) {
      current.endLine = line
      current.text += `\n${text}`
    }
  })
  return { pid: process.pid, functions }
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const { id, params } = JSON.parse(line)
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: parse(params) })}\n`)
  })
  .on("close", () => process.exit(0))
