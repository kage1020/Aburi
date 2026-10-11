import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { extractFile } from "@aburi/test-harness"
import { describe, expect, it } from "vitest"
import { analyzeUseArguments } from "../src/middleware"

/** The module-level `use` call written on the last line, after an express import and an app. */
async function useCall(line: string) {
  const source = `import express from "express"\nconst app = express()\n${line}\n`
  const { candidates } = await extractFile(langTypescriptPlugin, "src/a.ts", source)
  const call = candidates.find((candidate) => candidate.kind === "call")
  if (call === undefined) throw new Error(`no call Symbol in ${line}`)
  return call
}

describe("analyzeUseArguments", () => {
  it.each([
    ["an arity-3 arrow", "app.use((req, res, next) => next())", { hasRegularHandler: true }],
    ["an arity-4 arrow", "app.use((err, req, res, next) => next(err))", { hasErrorHandler: true }],
    [
      "an arity-4 function expression",
      "app.use(function (err, req, res, next) { return next(err) })",
      { hasErrorHandler: true },
    ],
    ["a handler named by an identifier", "app.use(logger)", { hasIdentifierArg: true }],
    ["an arity-2 arrow, which is neither shape", "app.use((req, res) => res.end())", {}],
  ])("reads %s", async (_label, line, flags) => {
    const shape = analyzeUseArguments((await useCall(line)).fullNode)

    expect(shape).toMatchObject({
      hasRegularHandler: false,
      hasErrorHandler: false,
      hasIdentifierArg: false,
      ...flags,
    })
  })

  it("reads a mount: a path literal, then a router identifier", async () => {
    const shape = analyzeUseArguments((await useCall("app.use('/api', router)")).fullNode)

    expect(shape).toEqual({
      hasErrorHandler: false,
      hasRegularHandler: false,
      firstArgIsPathLiteral: true,
      secondArgIsIdentifier: true,
      argCount: 2,
      hasIdentifierArg: true,
    })
  })

  it.each([
    ["in backticks", "app.use(`/api`, router)"],
    ["behind a comment", 'app.use(/* v1 */ "/api", router)'],
    ["in parentheses", 'app.use(("/api"), router)'],
    ["under an assertion", 'app.use("/api" as string, router)'],
  ])("reads the mount path written %s as the path it is", async (_label, line) => {
    const call = await useCall(line)
    expect(call.name).toBe("app__use__$api__d0")

    expect(analyzeUseArguments(call.fullNode)).toMatchObject({
      firstArgIsPathLiteral: true,
      argCount: 2,
    })
  })

  it("reads no path from a backtick with a substitution", async () => {
    // Its value is decided when it runs, so it is no more a path than an identifier is.
    const call = await useCall(`app.use(\`/\${v}\`, router)`)

    expect(analyzeUseArguments(call.fullNode)?.firstArgIsPathLiteral).toBe(false)
  })

  it.each([
    null,
    { placeholder: true },
  ])("returns null for %o, which is not a syntax node", (value) => {
    expect(analyzeUseArguments(value)).toBeNull()
  })
})
