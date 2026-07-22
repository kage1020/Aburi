import type { FrameworkManifest, SymbolKind } from "@aburi/types"
import type { ExpressExtKind } from "./ext-kinds"

interface ExpressExtKindEntry {
  id: ExpressExtKind
  baseKind: SymbolKind
  description: string
}

const EXT_KIND_ENTRIES: ExpressExtKindEntry[] = [
  {
    id: "framework:express:router",
    baseKind: "const",
    description:
      "Express Router instance produced by a top-level `Router()` or `express.Router()` call bound to a const.",
  },
  {
    id: "framework:express:route",
    baseKind: "call",
    description:
      "Route registration — a module-level `receiver.<method>(path, handler)` call where <method> is one of get/post/put/patch/delete/all.",
  },
  {
    id: "framework:express:middleware",
    baseKind: "call",
    description:
      "Non-error middleware — a module-level `receiver.use(...)` call whose handler argument has arity 3 (`req, res, next`), optionally preceded by a path literal.",
  },
  {
    id: "framework:express:error-middleware",
    baseKind: "call",
    description:
      "Error-handling middleware — a module-level `receiver.use(...)` call whose handler argument has arity 4 (`err, req, res, next`).",
  },
  {
    id: "framework:express:mount",
    baseKind: "call",
    description:
      "Sub-router mount point — a module-level `receiver.use(pathLiteral, subRouter)` call whose second argument is an identifier (assumed to reference an Express Router in scope).",
  },
]

export const frameworkExpressManifest: FrameworkManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "framework-express",
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: EXT_KIND_ENTRIES,
    extKindPrefixes: ["framework:express"],
    derivedByPrefixes: ["framework:express"],
    frameworks: ["express"],
  },
}
