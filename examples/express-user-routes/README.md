# An Express router gains a destructive route

A user API on Express and Drizzle. The change registers `DELETE /users`, a bulk delete behind the
`requireAdmin` middleware.

An Express route has no function name of its own, so Aburi names the registration after its method, path
and position, and treats it as a Symbol like any other: the report lists it as added, with the database
write it performs and the calls it makes. Nothing else in the router moved, and the report says so.
