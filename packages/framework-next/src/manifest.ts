import type { FrameworkManifest } from "@aburi/types"

export const NEXT_DERIVED_BY_PREFIX = "framework:next"

export const frameworkNextManifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  name: "framework-next",
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [
      {
        id: "framework:next:page",
        baseKind: "function",
        description:
          "Next.js App Router page component — the default export of app/**/page.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:layout",
        baseKind: "function",
        description:
          "Next.js App Router layout component — the default export of app/**/layout.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:template",
        baseKind: "function",
        description:
          "Next.js App Router template — the default export of app/**/template.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:loading",
        baseKind: "function",
        description:
          "Next.js App Router loading UI — the default export of app/**/loading.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:error",
        baseKind: "function",
        description:
          "Next.js App Router error boundary — the default export of app/**/error.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:not-found",
        baseKind: "function",
        description:
          "Next.js App Router not-found UI — the default export of app/**/not-found.{ts,tsx,js,jsx}.",
      },
      {
        id: "framework:next:route",
        baseKind: "function",
        description:
          "Next.js App Router route handler — a named HTTP verb export (GET / POST / PUT / DELETE / PATCH / OPTIONS / HEAD) in app/**/route.{ts,js}.",
      },
    ],
    extKindPrefixes: ["framework:next"],
    derivedByPrefixes: [NEXT_DERIVED_BY_PREFIX],
    // Matches the identifier `@aburi/core`'s Component autodetect uses for the `next` dependency.
    frameworks: ["nextjs"],
  },
} as const satisfies FrameworkManifest
