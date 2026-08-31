---
"@aburi/lang-typescript": minor
---

A class member written as a field holding a function is a member

`create(data) { … }` and `create = async (data) => { … }` are the same member written two
ways, and only the first had a Symbol. The second was a `public_field_definition`, so its body
stayed on the class — and because `new C()` resolves to the class Symbol
(`call-resolution.md` CR15), a factory whose whole body is `return new UserService(prisma)`
was reported as writing to the database. The same report the class-body change was about,
reproduced on the other common way to write a service.

A field whose value is an arrow or a function expression now gets a member Symbol of its own:
`kind: "method"`, named by the class-member convention (`C.create`, `C::create` for a static
one), with the function's signature and the field's decorators. The class stops carrying its
body. `arrow_function` and `function_expression` are the set, which is exactly the set
`const f = …` already used at module level, so the two levels are one decision.

What separates it from a field that is not a member is when the value runs: `seed = makeSeed()`
runs on construction and stays on the class; `seed = () => makeSeed()` runs when it is called
and moves. A parameter default (`create = (x = f()) => …`) and a decorator's arguments stay on
the class the way a method's do, because that is where they run.

The drop list follows: a class whose members are function-valued fields is no longer read as a
pure DTO.

Four shapes are deliberately left where they were. A computed, string-literal or numeric
member name gets no Symbol — admitting a name the qualified-name grammar refuses would turn a
file that extracts today into a file lost at the per-file boundary. A generator field is
outside the function set at both levels. A field whose value is a function behind a wrapper
(`handle = withAuth(async (r) => …)`, `useCallback`, `memoize`) is a call expression, not a
function, so it is a field: the report this fixes still reproduces on that spelling. And a
field named `constructor`, which an engine refuses and the grammar accepts, is refused a
Symbol rather than given the segment reserved for what `new C()` runs.

The IR moves for every class with a function-valued field: one new Symbol per field, and the
class's `fingerprint.logic` loses the bodies it was carrying, as do the callers whose
propagated effects came through one.
