import type { FrameworkManifest } from "@aburi/types"

/**
 * Plugin ref. Doubles as the attribution prefix on the errors this plugin raises about the
 * values a language plugin handed it, so the two can never drift apart.
 */
export const FRAMEWORK_NESTJS_PLUGIN_NAME = "framework-nestjs"

/**
 * Manifest for `@aburi/framework-nestjs`. The registry validates this at load time; the
 * shape is locked to `FrameworkManifest` so a mismatch shows up as a compile-time error
 * rather than at run time.
 *
 * Both `extKinds` (individual enumeration) and `extKindPrefixes` (prefix ownership) are
 * declared. The individual entries let `VocabRegistry.findExtKind()` return a
 * `baseKind` fallback so a consumer that only speaks core `SymbolKind` can still render
 * the Symbol as its underlying `class` / `method` shape. The prefix declaration keeps the
 * manifest open to future additions (any `framework:nestjs:*` id the classifier emits
 * later without a manifest bump is still recognized as owned).
 */
export const frameworkNestjsManifest: FrameworkManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: FRAMEWORK_NESTJS_PLUGIN_NAME,
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [
      {
        id: "framework:nestjs:module",
        baseKind: "class",
        description: "NestJS module class declared with @Module.",
      },
      {
        id: "framework:nestjs:controller",
        baseKind: "class",
        description: "NestJS controller class declared with @Controller.",
      },
      {
        id: "framework:nestjs:provider",
        baseKind: "class",
        description: "NestJS injectable provider declared with @Injectable.",
      },
      {
        id: "framework:nestjs:filter",
        baseKind: "class",
        description: "NestJS exception filter declared with @Catch.",
      },
      {
        id: "framework:nestjs:route",
        baseKind: "method",
        description:
          "NestJS route handler declared with an HTTP verb decorator or a microservice / WebSocket pattern decorator.",
      },
    ],
    extKindPrefixes: ["framework:nestjs"],
    derivedByPrefixes: ["framework:nestjs"],
    frameworks: ["nestjs"],
  },
}
