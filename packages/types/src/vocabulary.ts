/**
 * Reserved strings that travel in the IR as part of a value rather than as a value of their
 * own. They are shared because both sides of a boundary have to spell them identically: a
 * language plugin writes them and an effect plugin, the resolver, or a report reads them.
 */

/**
 * The segment a call target carries where the source addressed a property through brackets
 * with something that is not a name — `prisma[model].create()` is `prisma.<computed>.create`
 * (`lang-plugin.md` §4.4).
 *
 * Dropping the index instead does not shorten the call, it renames it: `prisma.create` is a
 * call the program does not contain, spelled like an ordinary two-segment method call, and a
 * consumer that counts segments reads it as one.
 *
 * The spelling is what makes the segment safe to write: `<` is outside the qualified-name
 * segment grammar (`ir-schema.md` §3.1), so a target carrying it matches no Symbol id and no
 * Symbol name, and resolves against nothing rather than against whatever the shortened name
 * would have found.
 *
 * A consumer that reads a fixed position of a target — the model of a delegate call, the
 * receiver before a verb — meets this segment where it expected a name, and *it names none*:
 * treat it as absent evidence, never as a name that happens to be spelled oddly.
 */
export const COMPUTED_TARGET_SEGMENT = "<computed>"
