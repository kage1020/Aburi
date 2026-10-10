import { importEdge } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { hasTrpcServerImport } from "../src/imports"
import { hasTrpcClientImport } from "../src/index"

const PATH = "src/client.ts"

function edge(source: string, line = 1): ImportEdge {
  return importEdge({ source, symbols: ["x"], line })
}

describe("hasTrpcClientImport", () => {
  it.each([
    "@trpc/client",
    "@trpc/react-query",
    "@trpc/next",
    "@trpc/client/links/httpBatchLink",
    "@trpc/react-query/shared",
    "@trpc/next/app-dir/client",
  ])("returns true for %s, a client package or one of its subpaths", (source) => {
    expect(hasTrpcClientImport([edge(source)], PATH)).toBe(true)
  })

  it.each([
    "@trpc/client-mock",
    "@trpc/nextjs-extra",
    "@trpc/react-query-devtools",
    "trpc",
    "not-@trpc/client",
    "@trpc/server",
    "@trpc/server/adapters/next",
    "@trpc/tanstack-react-query",
  ])("returns false for %s", (source) => {
    expect(hasTrpcClientImport([edge(source)], PATH)).toBe(false)
  })

  it("returns false when the import list is empty", () => {
    expect(hasTrpcClientImport([], PATH)).toBe(false)
  })

  it("returns true for a side-effect-only import, or one beside unrelated imports", () => {
    expect(hasTrpcClientImport([{ ...edge("@trpc/client"), symbols: [] }], PATH)).toBe(true)
    expect(
      hasTrpcClientImport([edge("react", 1), edge("@trpc/react-query", 2), edge("zod", 3)], PATH),
    ).toBe(true)
  })

  it("throws on an empty ImportEdge.source, naming the plugin, the file, and the line", () => {
    expect(() => hasTrpcClientImport([edge("", 7)], PATH)).toThrow(
      `effects-trpc (${PATH}, line 7): ImportEdge.source is empty`,
    )
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    expect(() => hasTrpcClientImport([edge("@trpc/client", 1), edge("", 2)], PATH)).toThrow(
      /ImportEdge\.source is empty/,
    )
  })
})

describe("hasTrpcServerImport", () => {
  it.each([
    "@trpc/server",
    "@trpc/server/adapters/next",
    "@trpc/server/adapters/fetch",
  ])("returns true for %s", (source) => {
    expect(hasTrpcServerImport([edge(source)], PATH)).toBe(true)
  })

  it.each([
    "@trpc/client",
    "@trpc/react-query",
    "@trpc/next",
    "@trpc/server-mock",
  ])("returns false for %s", (source) => {
    expect(hasTrpcServerImport([edge(source)], PATH)).toBe(false)
  })

  it("returns false when the import list is empty", () => {
    expect(hasTrpcServerImport([], PATH)).toBe(false)
  })

  it("throws on an empty ImportEdge.source, naming the plugin, the file, and the line", () => {
    expect(() => hasTrpcServerImport([edge("", 4)], PATH)).toThrow(
      `effects-trpc (${PATH}, line 4): ImportEdge.source is empty`,
    )
  })
})
