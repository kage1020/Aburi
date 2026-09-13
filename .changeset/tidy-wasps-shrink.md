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

Installing the toolchain pulled down 25 MB where under 4 MB does the same work. Nothing in it was
deliberate — each piece was a default nobody had reason to look at until the sizes were measured
side by side.

`@vscode/tree-sitter-wasm` was the bulk of it. It ships sixteen prebuilt grammars — bash, C#, C++,
Ruby, Rust, PHP, PowerShell and the rest, 21.6 MB — and `@aburi/lang-typescript` loads exactly two
of them. npm cannot install part of a tarball, so every consumer paid for the other fourteen to sit
on disk unread. The two grammars we do parse with are now vendored into the package's own `wasm/`
directory at build time and the dependency is a devDependency, which is the whole 18.9 MB. They are
byte-identical copies of the same upstream files, `wasm/NOTICE` records where they came from and
carries the upstream MIT licence, and bumping them is still a devDependency bump.

The rest was the published tarballs. `files` listed `src` alongside `dist`, so the TypeScript
sources shipped a second time next to the bundle that was built from them — and the sourcemaps
already embedded `sourcesContent`, so the copy was not even what a debugger reads. Sourcemaps and
declaration maps are no longer emitted at all: 1.6 MB across the workspace, most of it that same
source text a third time. `declarationMap` is what drove it, since tsdown forces JS sourcemaps on
whenever it is set — which is why `sourcemap: false` in every `tsdown.config.ts` had been quietly
doing nothing. Both map options are now off in `tsconfig.base.json` with a note saying why, because
flipping either one back silently restores all of it.

With the sources gone there is no longer a reason to ship the bundle unminified, so `minify` is on:
the runtime JS drops from 895 KB to 273 KB, 90 KB gzipped.

Published output is now `dist/*.mjs` and `dist/*.d.mts` — plus `wasm/` for the language plugin.
The trade is that a stack trace from an installed copy no longer resolves to original source; the
sources remain a `git clone` away, and no API, behaviour or output changed anywhere.
