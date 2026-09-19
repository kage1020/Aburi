import type { FrameworkManifest } from "@aburi/types"

/** Plugin ref; also the attribution prefix on errors about values a language plugin handed over. */
export const FRAMEWORK_NESTJS_PLUGIN_NAME = "framework-nestjs"

export const NESTJS_DERIVED_BY_PREFIX = "framework:nestjs"

export const frameworkNestjsManifest: FrameworkManifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
    derivedByPrefixes: [NESTJS_DERIVED_BY_PREFIX],
    frameworks: ["nestjs"],
  },
}
