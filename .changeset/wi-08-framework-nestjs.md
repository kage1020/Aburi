---
"@aburi/framework-nestjs": minor
---

Introduce `@aburi/framework-nestjs`, the first Aburi framework plugin. Implements the FrameworkPlugin contract from design/details/lang-plugin.md §5.2 for NestJS conventions.

### Class-level classification

- `@Module` → `framework:nestjs:module`
- `@Controller` → `framework:nestjs:controller`
- `@Injectable` → `framework:nestjs:provider`
- `@Catch` → `framework:nestjs:filter`

The winning role is the first recognized decorator in source order; boundary flags are emitted for every recognized decorator on the class so downstream tooling can inspect the full shape (e.g. `@Controller @Injectable class Hybrid` records both).

### Method-level classification

- HTTP verbs (`@Get` / `@Post` / `@Put` / `@Delete` / `@Patch` / `@Options` / `@Head` / `@All`) → `framework:nestjs:route` extKind + boundary
- Microservice / WebSocket pattern handlers (`@MessagePattern` / `@EventPattern` / `@SubscribeMessage`) → same `framework:nestjs:route` extKind + boundary
- Cross-cutting handlers (`@UseGuards` / `@UseInterceptors` / `@UsePipes` / `@UseFilters`) → boundary flag only, no extKind (a Guard-wrapped service method is boundary-worthy but not a route)

Non-classifiable Symbol kinds (functions, interfaces, types, const, namespace, enum) return `null` so the first-match-wins pipeline can hand off to other framework plugins.

### derivedBy policy

`derivedBy` preserves the source decorator identifier verbatim (`framework:nestjs:route:Post`, `framework:nestjs:handler:UseGuards`) so a grep from the emitted string lands directly on the source decorator.

### Manifest

Declares prefix ownership only: `extKindPrefixes: ["framework:nestjs"]`, `derivedByPrefixes: ["framework:nestjs"]`, `frameworks: ["nestjs"]`. No individual extKind enumeration, so adding new decorator support requires no manifest change.

### Public API

`nestjsFrameworkPlugin` (ready-to-register instance), `NestjsFrameworkPlugin` (class), `frameworkNestjsManifest`, `classifyNestjsSymbol`, plus the decorator vocabulary (`NESTJS_CLASS_DECORATORS`, `NESTJS_HTTP_METHOD_DECORATORS`, `NESTJS_HANDLER_DECORATORS`, `NESTJS_PATTERN_DECORATORS`, `classifyClassDecorator`, `isMethodBoundaryDecorator`).
