import { describe, expect, it } from "vitest"
// `hasTrpcServerImport` is the classifier's internal discriminator and is deliberately
// absent from the public barrel — imported from the module directly so its behaviour stays
// pinned without leaking it to consumers.
import { hasTrpcServerImport } from "../src/imports"
import { hasTrpcClientImport } from "../src/index"

const PATH = "src/client.ts"

function edge(source: string, line = 1) {
  return { source, symbols: ["x"], line, dynamic: false }
}

describe("hasTrpcClientImport", () => {
  it.each([
    "@trpc/client",
    "@trpc/react-query",
    "@trpc/next",
  ])("returns true for the client package root %s", (source) => {
    expect(hasTrpcClientImport([edge(source)], PATH)).toBe(true)
  })

  it.each([
    "@trpc/client/links/httpBatchLink",
    "@trpc/react-query/shared",
    "@trpc/next/app-dir/client",
  ])("returns true for the subpath %s", (source) => {
    // The gate is a prefix match rather than a closed allowlist — tRPC reorganizes its
    // subpath exports between minors and a stale allowlist would silently stop matching.
    expect(hasTrpcClientImport([edge(source)], PATH)).toBe(true)
  })

  it.each([
    "@trpc/client-mock",
    "@trpc/nextjs-extra",
    "@trpc/react-query-devtools",
    "trpc",
    "not-@trpc/client",
  ])("returns false for the lookalike specifier %s", (source) => {
    // The `/` separator in the subpath check is what keeps `@trpc/client-mock` and
    // friends from matching the `@trpc/client` root.
    expect(hasTrpcClientImport([edge(source)], PATH)).toBe(false)
  })

  it("returns false for @trpc/server — the server package is not a client gate signal", () => {
    expect(hasTrpcClientImport([edge("@trpc/server")], PATH)).toBe(false)
    expect(hasTrpcClientImport([edge("@trpc/server/adapters/next")], PATH)).toBe(false)
  })

  it("returns false for @trpc/tanstack-react-query", () => {
    // That integration's surface (`queryOptions()` / `mutationOptions()`) is out of the
    // v1 vocabulary, so passing the gate would only widen the false-positive window
    // without enabling any classification.
    expect(hasTrpcClientImport([edge("@trpc/tanstack-react-query")], PATH)).toBe(false)
  })

  it("returns false when the import list is empty", () => {
    expect(hasTrpcClientImport([], PATH)).toBe(false)
  })

  it("returns true for a side-effect-only import (empty symbols array)", () => {
    expect(
      hasTrpcClientImport([{ source: "@trpc/client", symbols: [], line: 1, dynamic: false }], PATH),
    ).toBe(true)
  })

  it("returns true when a client import sits alongside unrelated imports", () => {
    expect(
      hasTrpcClientImport([edge("react", 1), edge("@trpc/react-query", 2), edge("zod", 3)], PATH),
    ).toBe(true)
  })

  it("throws when the language plugin emits an empty ImportEdge.source, including the file path and line", () => {
    // ImportEdge.source is contract-guaranteed to be normalized and non-empty. Getting
    // `""` here means the upstream language plugin failed to normalize — silently
    // returning false would mask the bug.
    expect(() => hasTrpcClientImport([edge("", 7)], PATH)).toThrow(/ImportEdge\.source is empty/)
    expect(() => hasTrpcClientImport([edge("", 7)], PATH)).toThrow(
      new RegExp(PATH.replace(/\//g, "\\/")),
    )
    expect(() => hasTrpcClientImport([edge("", 7)], PATH)).toThrow(/line 7/)
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    // Order-independence pin — using `.some()` alone would short-circuit on the first
    // match and silently accept a broken edge later in the list.
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

  it("returns true when both client and server packages are imported in one file", () => {
    // A Next.js app can legitimately colocate a server caller and a client. Both gates
    // report true; the classifier's `query`-terminal suppression is what resolves the
    // resulting ambiguity.
    const imports = [edge("@trpc/client", 1), edge("@trpc/server", 2)]
    expect(hasTrpcServerImport(imports, PATH)).toBe(true)
    expect(hasTrpcClientImport(imports, PATH)).toBe(true)
  })

  it("throws on an empty ImportEdge.source with the file path in the message", () => {
    expect(() => hasTrpcServerImport([edge("", 4)], PATH)).toThrow(/ImportEdge\.source is empty/)
    expect(() => hasTrpcServerImport([edge("", 4)], PATH)).toThrow(
      new RegExp(PATH.replace(/\//g, "\\/")),
    )
  })
})
