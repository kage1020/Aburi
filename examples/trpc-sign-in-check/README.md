# A tRPC base procedure loses its sign-in check

A blog API on tRPC and Prisma. The change takes the session check out of `protectedProcedure`, the base
procedure `deletePost` is built from, so the mutation now runs for a visitor who is not signed in.

The check is written in the function handed to `.use`, and Aburi reads that function as the base
procedure's body: the report lists the removed guard and the `TRPCError` it threw as logic changes on
`protectedProcedure`. The mutation's own code did not change, so the report names only the base procedure.
