import type { FrameworkManifest } from "@aburi/types"

/**
 * Manifest for `@aburi/framework-react`. Declares the seven `framework:react:*` extKinds
 * this plugin can emit plus the shared `framework:react` prefix so the vocab registry can
 * resolve future additions by prefix ownership without a manifest bump.
 *
 * `frameworks: ["react"]` matches the identifier used by `@aburi/core`'s Component
 * autodetect for the `react` npm dependency — declared once here, no config change needed
 * on the consumer side.
 */
export const frameworkReactManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "framework-react",
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [
      {
        id: "framework:react:component",
        baseKind: "function",
        description:
          "React function component — a PascalCase-named function whose body returns JSX.",
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
          "Higher-order component — a function that takes a component and returns a component (with* naming convention or a PascalCase component parameter re-emitted as JSX).",
      },
    ],
    extKindPrefixes: ["framework:react"],
    derivedByPrefixes: ["framework:react"],
    frameworks: ["react"],
  },
} as const satisfies FrameworkManifest
