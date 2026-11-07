---
"@aburi/types": minor
"@aburi/diff": minor
---

An owner that no stage could pair by name is paired on its members. `class Invoice { render() }` that moved file without git rename information used to report `added Invoice` and `removed Invoice` beside `moved Invoice.render`, because a class name of one word and a null signature leave stage 3 and stage 4 nothing to read; a class pluralised in place split the same way while each of its methods paired. After stage 4, an unpaired class, namespace or object literal a binding holds is paired with the head owner its member pairs all point into, when every member pair of that head owner comes back from it, the two are of one kind, and their names pass the owner gate that stage 4 already asks of a member's owner. Nested owners are settled deepest first, so a namespace pairs on the class inside it. A class split into two, merged with another, or moved into a class of an unrelated name stays added and removed.

The pair's rationale is `name-signature`, and its `moved` or `moved+changed` entry carries `throughMembers`, the number of member pairs it rests on. The field is optional in `aburi.diff.v1.json` and written only on such a pair: a writer that predates it never paired an owner this way, so its absence means the pairing rests on the rationale alone. Under `--log-level debug`, stage 4 says why it left an owner unpaired although its members paired, and no longer writes its "not compared by name" line for an owner it then paired.

`matchStageNameSignature` takes `{ paired, logger }` as its third argument in place of a bare `Logger`; `paired` is what the earlier stages paired, which says where an owner's members went.
