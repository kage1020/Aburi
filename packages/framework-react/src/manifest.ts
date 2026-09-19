import type { FrameworkManifest } from "@aburi/types"
import { REACT_DERIVED_BY_PREFIX, type ReactExtKind } from "./ext-kinds"

/** `id` is pinned to `ReactExtKind` so the manifest cannot drift from `classify.ts`. */
interface ReactExtKindEntry {
  id: ReactExtKind
  baseKind: "function" | "const"
  description: string
}

const EXT_KIND_ENTRIES: ReactExtKindEntry[] = [
  {
    id: "framework:react:component",
    baseKind: "function",
    description: "React function component — a PascalCase-named function whose body returns JSX.",
  },
  {
    id: "framework:react:hook",
    baseKind: "function",
    description:
      "React custom hook — a function whose name matches /^use[A-Z]/, optionally calling other use* hooks internally.",
  },
  {
    id: "framework:react:context",
    baseKind: "const",
    description:
      "React context value produced by a top-level `createContext(...)` (or `React.createContext(...)`) call.",
  },
  {
    id: "framework:react:forward-ref",
    baseKind: "const",
    description:
      "Component wrapped by `forwardRef(...)` / `React.forwardRef(...)` to expose an imperative ref.",
  },
  {
    id: "framework:react:memo",
    baseKind: "const",
    description:
      "Component wrapped by `memo(...)` / `React.memo(...)` to skip re-renders on shallow-equal props.",
  },
  {
    id: "framework:react:provider",
    baseKind: "function",
    description:
      "Function component whose returned JSX is a context provider (`<X.Provider>`) — a common ancestor pattern.",
  },
  {
    id: "framework:react:hoc",
    baseKind: "function",
    description:
      "Higher-order component — a function whose name matches /^with[A-Z]/ (React community convention for functions that take a component and return a component).",
  },
]

export const frameworkReactManifest: FrameworkManifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  name: "framework-react",
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: EXT_KIND_ENTRIES,
    extKindPrefixes: ["framework:react"],
    derivedByPrefixes: [REACT_DERIVED_BY_PREFIX],
    // Matches the identifier `@aburi/core`'s Component autodetect uses for the `react` dependency.
    frameworks: ["react"],
  },
}
