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

`aburi init` writes `"framework-nestjs"` into `aburi.json` under `frameworks`,
which is the plugin manifest name the loader resolves (to `@aburi/framework-nestjs`
via the bare-name prefix — see
[`docs/plugin-development.md`](../../docs/plugin-development.md)). The short
framework id `"nestjs"` that component autodetect uses stays inside
`components[].frameworks`; the two fields carry different vocabularies and no
hand-editing is needed.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) §5.2 — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:nestjs:*`) plug into the shared vocab.
- [`docs/design/drop-list.md`](../../docs/design/drop-list.md)
