export const NESTJS_CLASS_DECORATORS: ReadonlyMap<string, { extKind: string; role: string }> =
  new Map([
    ["Module", { extKind: "framework:nestjs:module", role: "module" }],
    ["Controller", { extKind: "framework:nestjs:controller", role: "controller" }],
    ["Injectable", { extKind: "framework:nestjs:provider", role: "provider" }],
    ["Catch", { extKind: "framework:nestjs:filter", role: "filter" }],
  ])

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

export const NESTJS_HANDLER_DECORATORS: ReadonlySet<string> = new Set([
  "UseGuards",
  "UseInterceptors",
  "UsePipes",
  "UseFilters",
])

export const NESTJS_PATTERN_DECORATORS: ReadonlySet<string> = new Set([
  "MessagePattern",
  "EventPattern",
  "SubscribeMessage",
])

export function isMethodBoundaryDecorator(name: string): boolean {
  return (
    NESTJS_HTTP_METHOD_DECORATORS.has(name) ||
    NESTJS_HANDLER_DECORATORS.has(name) ||
    NESTJS_PATTERN_DECORATORS.has(name)
  )
}

/** Exported for symmetry with `isMethodBoundaryDecorator`. */
export function classifyClassDecorator(
  name: string,
): { extKind: string; role: string } | undefined {
  return NESTJS_CLASS_DECORATORS.get(name)
}
