// NestJS decorator vocabulary. Every extKind here must stay under `framework:nestjs`, the
// prefix the manifest declares ownership of.

/** Class-level decorators → extKind plus the semantic role `classifyClass` puts in `derivedBy`. */
export const NESTJS_CLASS_DECORATORS: ReadonlyMap<string, { extKind: string; role: string }> =
  new Map([
    ["Module", { extKind: "framework:nestjs:module", role: "module" }],
    ["Controller", { extKind: "framework:nestjs:controller", role: "controller" }],
    ["Injectable", { extKind: "framework:nestjs:provider", role: "provider" }],
    ["Catch", { extKind: "framework:nestjs:filter", role: "filter" }],
  ])

/** Each marks the method as a boundary and a `framework:nestjs:route`. */
export const NESTJS_HTTP_METHOD_DECORATORS: ReadonlySet<string> = new Set([
  "Get",
  "Post",
  "Put",
  "Delete",
  "Patch",
  "Options",
  "Head",
  "All",
])

/** Cross-cutting decorators: a boundary on their own, even on an unrouted service method. */
export const NESTJS_HANDLER_DECORATORS: ReadonlySet<string> = new Set([
  "UseGuards",
  "UseInterceptors",
  "UsePipes",
  "UseFilters",
])

/** `@nestjs/microservices` and `@nestjs/websockets` entry points, route-equivalent boundaries. */
export const NESTJS_PATTERN_DECORATORS: ReadonlySet<string> = new Set([
  "MessagePattern",
  "EventPattern",
  "SubscribeMessage",
])

/** True when `name` flips `Decorator.boundary` on a method: any of the three sets above. */
export function isMethodBoundaryDecorator(name: string): boolean {
  return (
    NESTJS_HTTP_METHOD_DECORATORS.has(name) ||
    NESTJS_HANDLER_DECORATORS.has(name) ||
    NESTJS_PATTERN_DECORATORS.has(name)
  )
}

/** `NESTJS_CLASS_DECORATORS.get`, exported for symmetry with `isMethodBoundaryDecorator`. */
export function classifyClassDecorator(
  name: string,
): { extKind: string; role: string } | undefined {
  return NESTJS_CLASS_DECORATORS.get(name)
}
