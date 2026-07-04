/**
 * NestJS decorator vocabulary.
 *
 * The classifier maps a decorator name to (a) the extKind it applies to the enclosing
 * Symbol and (b) whether it flags a decorator as a framework boundary. Class-level
 * entries land on the class Symbol; method-level entries land on individual methods.
 *
 * The tables are namespace-locked to `framework:nestjs` — any addition must live under
 * that prefix so the runtime registry stays consistent with the manifest's declared
 * ownership.
 */

/**
 * Class-level decorators. Each entry sets an extKind and marks its own decorator as a
 * boundary so the framework role is visible in the IR without a follow-up render pass.
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
 * Union of every decorator that flips a `Decorator.boundary` to true when it appears on a
 * method Symbol. Callers use this instead of walking each set individually.
 */
export function isMethodBoundaryDecorator(name: string): boolean {
  return (
    NESTJS_HTTP_METHOD_DECORATORS.has(name) ||
    NESTJS_HANDLER_DECORATORS.has(name) ||
    NESTJS_PATTERN_DECORATORS.has(name)
  )
}

/** Union of every decorator that appears on a class and produces a class extKind. */
export function classifyClassDecorator(
  name: string,
): { extKind: string; role: string } | undefined {
  return NESTJS_CLASS_DECORATORS.get(name)
}
