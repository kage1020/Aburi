---
name: add-showcase-example
description: Add or change an example on the docs site's Showcase (examples/ → /showcase). Use when asked to add an example, demo a framework or change type on the site, or when a showcase page needs updating.
---

# Add a showcase example

Every page under `/showcase` is rendered from a directory in `examples/` by `@aburi/examples`' build. The
build commits `before/` and then `after/` to a scratch git repository, runs `aburi diff HEAD~1..HEAD` with
the real CLI and plugins, and writes the page. Nothing on the page is hand-written except the README.

## Layout

```
examples/<slug>/
  README.md     # "# Title" line, then the narrative. The first paragraph is the summary on /showcase.
  aburi.json    # the config both sides are scanned with; it is shown on the page as written
  before/       # the project before the change (include a package.json naming the framework)
  after/        # the same project after it
```

The slug is the URL (`/showcase/<slug>`); pages are listed in slug order. The sources under `before/` and
`after/` are sample data in other ecosystems' idioms — Biome skips them, and they need not compile here.

## Steps

1. Pick one change worth reviewing (a removed guard, a new route, an added write, a move or rename that is
   not a behaviour change). Keep the project to the files the change needs.
2. Write `before/`, copy it to `after/`, make the change.
3. Render and read the actual report — do not write the README first:
   ```bash
   pnpm turbo run build --filter=@aburi/examples
   cat examples/dist/<slug>.md
   ```
4. Write the README from what the report really says. Never claim the report shows something it does not;
   if Aburi misses part of the change, either rework the example or leave that part out, and tell the user
   about the gap.
5. `pnpm --filter @aburi/examples test` renders every example; the renderer refuses an example whose change
   the report does not see.
6. Preview: `pnpm --filter @aburi/docs dev` (it builds the packages the site depends on first).

## The plugins an example can name

`examples/package.json` devDepends on the plugins the examples use. A plugin a new example needs must be
added there with `pnpm --filter @aburi/examples add -D '@aburi/<plugin>@workspace:*'`.
