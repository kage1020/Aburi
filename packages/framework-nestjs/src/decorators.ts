/**
 * NestJS decorator vocabulary — three method-level sets and one class-level map.
 *
 * Only the class-level map carries per-entry extKind data; the method-level sets are
 * flat name lists because their extKind assignment is uniform (HTTP verbs and pattern
 * handlers all get `framework:nestjs:route`, cross-cutting handlers get nothing on the
 * extKind axis and only flip the boundary flag).
 *
 * The tables are namespace-locked to `framework:nestjs` — any addition must live under
 * that prefix so the runtime registry stays consistent with the manifest's declared
 * ownership.
 */

/**
 * Class-level decorators, mapping the source identifier to its extKind and to the
 * semantic role that `classifyClass` embeds in the emitted `derivedBy`.
 */
export const NESTJS_CLASS_DECORATORS: ReadonlyMap<string, { extKind: string; role: string }> =
  new Map([
    ["Module", { extKind: "framework:nestjs:module", role: "module" }],
    ["Controller", { extKind: "framework:nestjs:controller", role: "controller" }],
    ["Injectable", { extKind: "framework:nestjs:provider", role: "provider" }],
    ["Catch", { extKind: "framework:nestjs:filter", role: "filter" }],
  ])

/**
 * HTTP method decorators — each marks the decorated method as a framework boundary and
 * assigns a `framework:nestjs:route` extKind so downstream tooling can filter route
 * handlers as one class.
 */
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

/**
 * Cross-cutting method decorators — Guards / Interceptors / Pipes / Filters wire framework
 * lifecycle machinery around a method. They are boundary-worthy on their own even when the
 * method itself is not routed (e.g. an internal service method under a Guard).
 */
export const NESTJS_HANDLER_DECORATORS: ReadonlySet<string> = new Set([
  "UseGuards",
  "UseInterceptors",
  "UsePipes",
  "UseFilters",
])

/**
 * Microservice / WebSocket pattern-style entry points. `@MessagePattern` and
 * `@EventPattern` are the current @nestjs/microservices vocabulary; `@SubscribeMessage`
 * comes from @nestjs/websockets. All three are treated as route-equivalent boundaries
 * because they are the same kind of externally-observable entry point that HTTP routes
 * are — the boundary flag surfaces them consistently in the Aburi IR.
 */
export const NESTJS_PATTERN_DECORATORS: ReadonlySet<string> = new Set([
  "MessagePattern",
  "EventPattern",
  "SubscribeMessage",
])

/**
 * Predicate: true when `name` names a decorator that flips a `Decorator.boundary` to true
 * on a method Symbol (HTTP verb OR pattern handler OR cross-cutting handler). Consumers
 * use this instead of testing the three sets individually.
 */
export function isMethodBoundaryDecorator(name: string): boolean {
  return (
    NESTJS_HTTP_METHOD_DECORATORS.has(name) ||
    NESTJS_HANDLER_DECORATORS.has(name) ||
    NESTJS_PATTERN_DECORATORS.has(name)
  )
}

/**
 * Lookup: return the `{ extKind, role }` entry for a class-level decorator name, or
 * `undefined` when `name` is not one of the four class-level decorators this plugin
 * recognizes. Same shape as `Map.get` for symmetry with the underlying table.
 */
export function classifyClassDecorator(
  name: string,
): { extKind: string; role: string } | undefined {
  return NESTJS_CLASS_DECORATORS.get(name)
}
