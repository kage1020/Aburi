# @aburi/plugin-process

Drives a parser or classifier written in another language from a JavaScript Aburi plugin: one
long-lived process per scan, answering JSON-RPC requests over stdio. A plugin for Python or Go can
then use `go/packages` or a Python type checker instead of syntax alone, and stays an ordinary
plugin to the core.

## Install

```bash
pnpm add @aburi/plugin-process
```

## Usage

```ts
import { createPluginProcess, type PluginProcess } from "@aburi/plugin-process"

let parser: PluginProcess

export const plugin = {
  // manifest, languageId, fileExtensions, capabilities …
  async init(ctx) {
    parser = createPluginProcess({ command: "python3", args: ["-m", "my_parser"], cwd: ctx.workspaceRoot })
  },
  async cleanup() {
    await parser.close()
  },
  async parseFile(file) {
    const tree = await parser.request("parse", file)
    return { tree, errors: tree.errors, imports: tree.imports }
  },
  // extractSymbols, walkBody and normalizeAst read the JSON tree the process answered with.
}
```

The scan calls `init` before its first file and `cleanup` after its last plugin call, so the
process lives as long as the scan. The first request starts it.

## The other end

One JSON-RPC 2.0 message per line, UTF-8:

```
→ {"jsonrpc":"2.0","id":1,"method":"parse","params":{"path":"src/app.py","content":"…"}}
← {"jsonrpc":"2.0","id":1,"result":{…}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"…"}}
```

Answers may come in any order. Anything else on stdout is a fault, so diagnostics go to stderr.
The process exits when its stdin closes.

A minimal Python peer:

```python
import json, sys

for line in sys.stdin:
    request = json.loads(line)
    result = parse(request["params"])  # your parser
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `command`, `args` | — | Started with no shell |
| `cwd`, `env` | the host's | The process's working directory and environment |
| `timeoutMs` | `30000` | How long a request may wait, the start included; `request(method, params, { timeoutMs })` overrides it for one |
| `maxResponseBytes` | 256 MiB | The longest line the process may write |

## Failures

A failed request rejects with a `PluginProcessError` whose `code` is one of `error-response`,
`exited`, `timeout`, `oversize`, `protocol`, `start-failed`, `abandoned` or `closed`. Thrown from
`parseFile`, it withdraws that one file and the scan goes on. A process that ended is replaced by
the next request; after three in a row end without answering anything, requests fail with
`abandoned` until `close`. An idle process never keeps its host alive.

## See also

- [`docs/design/plugin-process.md`](../../docs/design/plugin-process.md) — the contract.
- [`docs/design/lang-plugin.md`](../../docs/design/lang-plugin.md) §3 — the plugin lifecycle.
