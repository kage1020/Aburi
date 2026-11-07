# AI coding agents

`@aburi/mcp` puts Aburi behind the [Model Context Protocol](https://modelcontextprotocol.io), so
an agent such as Claude Code can ask what its edits did, what a component exposes, or what one
function reaches, and read the same report a reviewer would. The server runs the `aburi` CLI for
every question and answers with what it printed. It holds no model and calls none: the facts are
Aburi's, and the reading is the agent's.

## Set it up

Install the server beside the CLI and the plugins your `aburi.json` names:

```bash
pnpm add -D @aburi/mcp @aburi/cli @aburi/lang-typescript
```

Then register it with the agent, from the workspace root. For Claude Code:

```bash
claude mcp add aburi -- pnpm exec aburi-mcp
```

Most other clients take a JSON entry:

```json
{ "mcpServers": { "aburi": { "command": "npx", "args": ["-y", "@aburi/mcp"] } } }
```

Either way the server runs the `@aburi/cli` your workspace installed, because that is the CLI
that can load the plugins `aburi.json` names. `--cwd <path>` serves another directory, and
`--config <path>` passes a config file to every run.

## What the agent can ask

| Tool | Answers with |
|---|---|
| `scan` | The census of a fresh scan, and an id for it (`scan-1`, `scan-2`, …) |
| `workspace` | The workspace overview: Components, the dependencies between them, the effects they reach |
| `component` | One Component's page: its public API, its Symbols, and the effects each reaches |
| `explain` | One Symbol, every Symbol of a file, or the candidates a name matches |
| `diff` | The report of a change, as Markdown or JSON, or the one Slice holding a given Symbol |

`workspace`, `component` and `explain` scan the working tree first, since the agent is the one
changing it between calls. To ask several questions of one scan, call `scan` once and pass its id
as `scan`.

`diff` takes either a `refspec`, as `aburi diff` does, or two sides:

- `{ refspec: "main..HEAD" }` is what the branch changed, uncommitted edits included, because the
  head is read from the working tree.
- `{ refspec: "HEAD..HEAD" }` is what the uncommitted edits did.
- `{ base: "scan-1", head: "scan-2" }` is what changed between two scans, so an agent can scan,
  edit, scan again and see exactly what its edit did.

`failOn`, `failOnScope` and `maxBytes` work as their [CLI options](../reference/cli.md#aburi-diff) do: a
tripped gate still answers with the report, and says which clause tripped. `symbol` narrows the
answer to the [Slice](./reading-the-report.md#a-slice) holding that Symbol, with the change of each of its
members.

## What it leaves alone

The server writes only in a temporary directory of its own, removed when the agent disconnects,
so no `out/` appears in the workspace. It runs one question at a time, and a question the agent
cancels ends the run answering it.

The [design document](../design/mcp-server.md) has the full contract.
