import type { FrameworkManifest } from "@aburi/types"

/**
 * Manifest for `@aburi/framework-nestjs`. The registry validates this at load time; the
 * shape is locked to `FrameworkManifest` so a mismatch shows up as a compile-time error
 * rather than at run time.
 *
 * The plugin claims prefix ownership of `framework:nestjs` for both extKinds and the
 * derivedBy channel, plus the `nestjs` name in the Component.frameworks list. It does not
 * enumerate individual extKind ids — the design allows either individual enumeration or
 * prefix ownership, and prefix ownership keeps the manifest short as new NestJS decorators
 * appear.
 */
export const frameworkNestjsManifest: FrameworkManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "framework-nestjs",
  version: "0.0.0",
  type: "framework",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: ["framework:nestjs"],
    derivedByPrefixes: ["framework:nestjs"],
    frameworks: ["nestjs"],
  },
}
