import type { FrameworkManifest } from "@aburi/types"
import { TRPC_DERIVED_BY_PREFIX, type TrpcExtKind } from "./ext-kinds"

/** `id` is pinned to `TrpcExtKind` so the manifest cannot drift from `classify.ts`. */
interface TrpcExtKindEntry {
  id: TrpcExtKind
  baseKind: "const"
  description: string
}

const EXT_KIND_ENTRIES: TrpcExtKindEntry[] = [
  {
    id: "framework:trpc:instance",
    baseKind: "const",
    description:
      "The tRPC instance — a const initialised by `initTRPC.create(...)`, configured on the way or not (`initTRPC.context<C>().create()`).",
  },
  {
    id: "framework:trpc:router",
    baseKind: "const",
    description:
      "A tRPC router — a const initialised by `router({...})` or `createTRPCRouter({...})`, on the instance or not, or by `mergeRouters(...)`.",
  },
  {
    id: "framework:trpc:procedure",
    baseKind: "const",
    description:
      "A tRPC procedure — a const initialised by a `query`, `mutation` or `subscription` handed its resolver, on a chain built from a procedure (`t.procedure`, or a name ending in `Procedure`).",
  },
  {
    id: "framework:trpc:base-procedure",
    baseKind: "const",
    description:
      "A reusable base procedure — a const initialised by `t.procedure`, or by `use`, `input`, `output`, `meta` or `concat` on a chain built from a procedure.",
  },
  {
    id: "framework:trpc:middleware",
    baseKind: "const",
    description:
      "A tRPC middleware — a const initialised by `middleware(fn)`, on the instance or not.",
  },
]

export const frameworkTrpcManifest: FrameworkManifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  name: "framework-trpc",
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: EXT_KIND_ENTRIES,
    extKindPrefixes: [TRPC_DERIVED_BY_PREFIX],
    derivedByPrefixes: [TRPC_DERIVED_BY_PREFIX],
    frameworks: ["trpc"],
  },
}
