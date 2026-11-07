---
"@aburi/core": minor
"@aburi/lang-typescript": patch
"@aburi/framework-express": patch
---

`walkReceiverChain` and `chainCalls` export the one walk down a call's receiver chain that `calleeName` reads. The TypeScript plugin's `call-statement:` entry and `chained-call` tag, and the calls Express reads a registration's path and middleware from, are read off it too, so a framework's name for a registration and the language plugin's can no longer drift apart. No entry or name moves.
