/**
 * Reserved strings that travel in the IR as part of a value rather than as a value of their
 * own. They are shared because both sides of a boundary have to spell them identically: a
 * language plugin writes them and an effect plugin, the resolver, or a report reads them.
 */

/**
 * The segment a call target carries where the source addressed a property through brackets
 * with something that is not a name — `prisma[model].create()` is `prisma.<computed>.create`
 * (`lang-plugin.md`).
 *
 * Dropping the index instead does not shorten the call, it renames it: `prisma.create` is a
 * call the program does not contain, spelled like an ordinary two-segment method call, and a
 * consumer that counts segments reads it as one.
 *
 * The spelling is what makes the segment safe to write: `<` is outside the qualified-name
 * segment grammar (`ir-schema.md`), so a target carrying it matches no Symbol id and no
 * Symbol name, and resolves against nothing rather than against whatever the shortened name
 * would have found.
 *
 * A consumer that reads a fixed position of a target — the model of a delegate call, the
 * receiver before a verb — meets this segment where it expected a name, and *it names none*:
 * treat it as absent evidence, never as a name that happens to be spelled oddly.
 */
export const COMPUTED_TARGET_SEGMENT = "<computed>"

/**
 * The `Decorator.name` written where the decorator's expression has no name to read —
 * `@(x as any)`, `@(x!)`, `@(a[b])` (`lang-plugin.md`).
 *
 * TypeScript accepts any parenthesized expression as a decorator. A name, a member path or a
 * call in parentheses is read through them; anything else has no name to read. It is still a
 * decorator, so it stays in the list, with its text in `raw`; carrying the text in `name`
 * instead would put arbitrary source, line breaks included, into a field every consumer
 * treats as an identifier.
 *
 * `<` cannot begin an identifier, so the name matches no framework's vocabulary: a plugin
 * matching names against a table needs no case for it. Treat it as a decorator whose name is
 * unknown, never as one spelled oddly.
 */
export const UNNAMED_DECORATOR = "<expression>"
