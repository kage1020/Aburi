---
"@aburi/lang-typescript": patch
"@aburi/markdown-projection": patch
"@aburi/framework-express": patch
"@aburi/framework-nestjs": patch
"@aburi/framework-react": patch
"@aburi/framework-next": patch
"@aburi/effects-drizzle": patch
"@aburi/effects-prisma": patch
"@aburi/effects-trpc": patch
"@aburi/plugin-registry": patch
"@aburi/github-action": patch
"@aburi/effects-nest": patch
"@aburi/config": patch
"@aburi/types": patch
"@aburi/core": patch
"@aburi/diff": patch
"@aburi/cli": patch
---

Ship the packages, not the workshop

Installing `@aburi/cli` and its dependency closure put 22.08 MB of prebuilt parser binaries
on disk to read 2.86 MB of them. Nothing in that was deliberate — each piece was a default
nobody had reason to look at until the sizes were measured side by side. Every number
below is decimal MB, measured on this branch against its base.

`@vscode/tree-sitter-wasm` was the bulk of it. It ships sixteen prebuilt grammars totalling
21.66 MB — bash, C#, C++, Ruby, Rust, PHP, PowerShell and the rest — and
`@aburi/lang-typescript` loads exactly two of them, `tree-sitter-typescript` and
`tree-sitter-tsx`, together 2.86 MB. npm cannot install part of a tarball, so every
consumer paid for the other fourteen, 18.80 MB, to sit on disk unread.

`scripts/copy-grammars.mjs` now vendors the two we parse with into the package's own
`wasm/` at build time and the dependency drops to a devDependency, which takes that
directory from 22.08 MB to 2.86 MB. The copies are byte-identical to the upstream files.
`wasm/NOTICE` records their provenance and reproduces both the licence text upstream
distributes and the component registration from its `cgmanifest.json`, and bumping the
grammars stays an ordinary devDependency bump.

The rest was the published tarballs. `files` listed `src` beside `dist`, so the TypeScript
sources shipped a second time next to the bundle built from them — and the sourcemaps
already embedded `sourcesContent`, so that copy was not even what a debugger reads.

Maps are no longer emitted at all: 1.67 MB across the workspace, most of it the same
source text a third time. `declarationMap` alone drove it — `sourceMap` never had any
effect on this build, because it is `rolldown-plugin-dts` that turns on rolldown's shared
`output.sourcemap` whenever `declarationMap` is set, and that is what overrode
`sourcemap: false` in all seventeen `tsdown.config.ts` files. `declarationMap` is now off
in `tsconfig.base.json` with a note naming `dts: { sourcemap }` as the direct lever, since
setting it back silently restores every byte.

With the sources gone there is no longer a reason to ship the bundle unminified, so
`minify` is on: summed across the seventeen published packages, every `.mjs` under `dist/`
goes from 916,821 to 279,839 bytes.

Published output is now `dist/*.mjs` and `dist/*.d.mts`, plus `wasm/` for the language
plugin. The trade is that a stack trace from an installed copy no longer resolves to
original source; the sources remain a `git clone` away, and no API, behaviour or emitted
IR changed anywhere.
