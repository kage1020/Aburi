---
"@aburi/cli": patch
"@aburi/config": patch
"@aburi/core": patch
"@aburi/diff": patch
"@aburi/effects-drizzle": patch
"@aburi/effects-nest": patch
"@aburi/effects-prisma": patch
"@aburi/effects-trpc": patch
"@aburi/framework-express": patch
"@aburi/framework-nestjs": patch
"@aburi/framework-next": patch
"@aburi/framework-react": patch
"@aburi/framework-trpc": patch
"@aburi/lang-typescript": patch
"@aburi/markdown-projection": patch
"@aburi/mcp": patch
"@aburi/plugin-process": patch
"@aburi/plugin-registry": patch
"@aburi/types": patch
---

Declare `engines.node` as `>=24`, the Node.js version the documentation already requires, so a package manager can say so on an older Node instead of the package failing at run time.
