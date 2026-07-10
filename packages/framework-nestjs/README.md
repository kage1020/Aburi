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

In v0.1, `aburi init` writes the short framework name `"nestjs"` into
`aburi.json` under `frameworks` (matching the component-autodetect vocabulary
in `@aburi/core`). The plugin loader currently resolves that short name to
`@aburi/nestjs` (bare-name prefix, no bucket segment inferred — see
[`docs/plugin-development.md`](../../docs/plugin-development.md)), so the
generated `aburi.json` needs a one-time edit from `"nestjs"` → `"framework-nestjs"`
for the loader to pick this package up. A follow-up will close the gap by
teaching either `init` to emit `framework-nestjs` or the loader to widen its
resolution table.

## See also

- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) §5.2 — the framework `classifySymbol` contract this plugin implements.
- [`docs/design/extension-vocab.md`](../../docs/design/extension-vocab.md) — how framework `extKind` namespaces (`framework:nestjs:*`) plug into the shared vocab.
- [`docs/design/drop-list.md`](../../docs/design/drop-list.md)
