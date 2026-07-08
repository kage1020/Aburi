# @aburi/framework-nestjs

NestJS framework plugin for `@aburi/core`. Classifies Symbols the language
plugin discovers as NestJS-specific extKinds and toggles decorator boundaries
so the scan pipeline knows which methods are externally-observable entry
points.

Recognised vocabulary:

| Source shape | `extKind` |
|---|---|
| `@Module()` | `framework:nestjs:module` |
| `@Controller()` | `framework:nestjs:controller` |
| `@Injectable()` | `framework:nestjs:provider` |
| `@Catch()` | `framework:nestjs:filter` |
| `@Get / @Post / @Put / @Delete / @Patch / @Options / @Head / @All` | `framework:nestjs:route` (method) |
| `@MessagePattern / @EventPattern / @SubscribeMessage` | `framework:nestjs:route` (method) |
| `@UseGuards / @UseInterceptors / @UsePipes / @UseFilters` | boundary flag only |

Boundary decorators mark the containing method Symbol as an observable entry
point — `@aburi/core`'s drop rules exempt these from the "empty body / no rules"
drop path so route handlers always survive into the IR.

## Install

```bash
pnpm add @aburi/framework-nestjs
```

## Usage

```ts
import { nestjsFrameworkPlugin } from "@aburi/framework-nestjs"
```

The plugin package name is `framework-nestjs` — `aburi init` writes it into
`aburi.json` under `frameworks` when it autodetects NestJS in your dependencies.

## See also

- [`design/details/framework-plugin.md`](../../design/details/framework-plugin.md)
- [`design/details/drop-list.md`](../../design/details/drop-list.md)
