import { describe, expect, it } from "vitest"
import { compileRules, readRuleLines } from "../../src/scan/gitignore-pattern"

/**
 * One `.gitignore`'s rules against one path. Every expectation here was measured with git
 * 2.43 (`git ls-files -o --exclude-standard` or `git check-ignore --no-index`) on the same rules
 * and paths, not reasoned out of the documentation, which git's own matcher departs from in
 * places (`a**\/b` below).
 */
function verdicts(content: string, paths: readonly string[], isDirectory = false): string[] {
  const rules = compileRules(readRuleLines(Buffer.from(content, "utf8")))
  return paths.map((path) => rules.decide(path, isDirectory))
}

describe("which lines are rules", () => {
  it("drops one CR, a leading BOM, comments, and trailing spaces unless escaped", () => {
    expect(verdicts("\ufeffa.ts\r\n#b.ts\r\nc.ts   \r\n", ["a.ts", "#b.ts", "c.ts"])).toEqual([
      "ignored",
      "none",
      "ignored",
    ])
    expect(verdicts("a\\ \n", ["a ", "a"])).toEqual(["ignored", "none"])
    expect(verdicts("a\t\n", ["a\t", "a"])).toEqual(["ignored", "none"])
  })

  it("reads a lone `!`, a lone `/` and a line of spaces as rules that match nothing", () => {
    expect(verdicts("*\n!\n", ["top.ts"])).toEqual(["ignored"])
    expect(verdicts("/\n   \n", ["a"])).toEqual(["none"])
    expect(verdicts("/\n", ["a"], true)).toEqual(["none"])
  })

  it("takes `\\#` and `\\!` as the characters themselves", () => {
    expect(verdicts("\\#c.ts\n\\!a.ts\n", ["#c.ts", "!a.ts", "a.ts"])).toEqual([
      "ignored",
      "ignored",
      "none",
    ])
  })

  it("lets the last rule that matches decide, and says nothing when none does", () => {
    expect(verdicts("*.ts\n!keep.ts\n", ["keep.ts", "drop.ts", "x.js"])).toEqual([
      "kept",
      "ignored",
      "none",
    ])
  })
})

describe("what a rule is matched against", () => {
  it("matches a slash-free rule against the basename at any depth, anything else from the file's own directory", () => {
    expect(verdicts("d.ts\n", ["d.ts", "e/d.ts"])).toEqual(["ignored", "ignored"])
    expect(verdicts("x/y\n", ["x/y", "a/x/y"])).toEqual(["ignored", "none"])
    expect(verdicts("/d\n", ["d", "e/d"])).toEqual(["ignored", "none"])
  })

  it("matches a trailing-slash rule against directories only", () => {
    expect(verdicts("d/\n", ["d", "f/d"])).toEqual(["none", "none"])
    expect(verdicts("d/\n", ["d", "f/d"], true)).toEqual(["ignored", "ignored"])
  })

  it("answers about the path alone, not about the directories above it", () => {
    expect(verdicts("third_party/*\n", ["third_party/ourlib/index.ts"])).toEqual(["none"])
    expect(verdicts("third_party/*\n", ["third_party/ourlib"], true)).toEqual(["ignored"])
  })
})

describe("the glob", () => {
  it("reads `**` as directories only between slashes or at an end", () => {
    expect(verdicts("x/**/c.ts\n", ["x/c.ts", "x/a/b/c.ts", "xa/c.ts"])).toEqual([
      "ignored",
      "ignored",
      "none",
    ])
    expect(verdicts("**/c.ts\n", ["c.ts", "a/b/c.ts"])).toEqual(["ignored", "ignored"])
    expect(verdicts("abc/**\n", ["abc/x", "abc/d/y", "abcd"])).toEqual([
      "ignored",
      "ignored",
      "none",
    ])
    expect(verdicts("d/a**b\n", ["d/ab", "d/a/x/b"])).toEqual(["ignored", "none"])
  })

  it("reads `**` before an escaped slash as directories too, without the zero-directory case", () => {
    expect(verdicts("x/**\\/c.ts\n", ["x/a/b/c.ts", "x/c.ts"])).toEqual(["ignored", "none"])
  })

  it("reads `**` after a literal head as at the start, the way git's split leaves it", () => {
    expect(verdicts("a**/b\n", ["a/b", "a/x/b", "ay/x/b"])).toEqual([
      "ignored",
      "ignored",
      "ignored",
    ])
  })

  it("matches `src/**/` against directories below src only", () => {
    expect(verdicts("src/**/\n", ["src/a.ts"])).toEqual(["none"])
    expect(verdicts("src/**/\n", ["src/sub", "src"], true)).toEqual(["ignored", "none"])
  })

  it("never lets `*`, `?` or a bracket take a slash", () => {
    expect(
      verdicts(
        "a*b\na?b\na[/]b\n",
        ["a/b"].map((p) => `x/${p}`),
      ),
    ).toEqual(["none"])
    expect(verdicts("x/a*b\n", ["x/a/b"])).toEqual(["none"])
    expect(verdicts("x/a?b\n", ["x/a/b"])).toEqual(["none"])
    expect(verdicts("x/a[^c]b\n", ["x/a/b", "x/axb"])).toEqual(["none", "ignored"])
    expect(verdicts("a[/]b\na[.-0]b\n", ["a/b", "a.b", "a0b"])).toEqual([
      "none",
      "ignored",
      "ignored",
    ])
  })

  it("takes one byte for `?`, as git does", () => {
    expect(verdicts("a?.ts\n", ["a\u00e9.ts", "ax.ts"])).toEqual(["none", "ignored"])
    expect(verdicts("a??.ts\n", ["a\u00e9.ts"])).toEqual(["ignored"])
    expect(verdicts("a[\u00e9]\n", ["a\u00e9", "ae"])).toEqual(["none", "none"])
  })

  it("escapes with a backslash, and a trailing lone one matches nothing", () => {
    expect(verdicts("q\\?.ts\n", ["q?.ts", "qx.ts"])).toEqual(["ignored", "none"])
    expect(verdicts("a\\\n", ["a", "a\\"])).toEqual(["none", "none"])
  })
})

describe("brackets", () => {
  it("reads `]` first as a member, and `!` or `^` as negation", () => {
    expect(verdicts("a[]].ts\n", ["a].ts", "a1.ts"])).toEqual(["ignored", "none"])
    expect(verdicts("a[!]]\n", ["a]", "ab"])).toEqual(["none", "ignored"])
    expect(verdicts("a[^x]\n", ["ab", "ax"])).toEqual(["ignored", "none"])
    expect(verdicts("a[\\]]\n", ["a]", "a\\"])).toEqual(["ignored", "none"])
  })

  it("reads ranges as git does: the low end alone when reversed, `-` literal at an edge or after a range", () => {
    expect(verdicts("a[z-a]\n", ["aa", "am", "az", "a-"])).toEqual([
      "none",
      "none",
      "ignored",
      "none",
    ])
    expect(verdicts("a[b-]\n", ["ab", "a-", "ac"])).toEqual(["ignored", "ignored", "none"])
    expect(verdicts("a[-b]\n", ["ab", "a-", "ac"])).toEqual(["ignored", "ignored", "none"])
    expect(verdicts("a[a-c-e]\n", ["ab", "a-", "ad", "ae"])).toEqual([
      "ignored",
      "ignored",
      "none",
      "ignored",
    ])
  })

  it("knows the POSIX classes, ASCII only", () => {
    expect(verdicts("a[[:digit:]].ts\n", ["a1.ts", "ax.ts"])).toEqual(["ignored", "none"])
    expect(verdicts("a[[:punct:]]\n", ["a!", "a~", "a_", "ab"])).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "none",
    ])
    for (const [name, inside, outside] of [
      ["alnum", "z", "-"],
      ["alpha", "Q", "1"],
      ["blank", "\t", "\n"],
      ["cntrl", "\u0001", " "],
      ["graph", "~", " "],
      ["lower", "q", "Q"],
      ["print", " ", "\u007f"],
      ["space", "\r", "\u000b"],
      ["upper", "Q", "q"],
      ["xdigit", "F", "g"],
    ] as const) {
      expect(verdicts(`a[[:${name}:]]\n`, [`a${inside}`, `a${outside}`]), name).toEqual([
        "ignored",
        "none",
      ])
    }
  })

  it("matches nothing for an unknown class or an unterminated bracket", () => {
    expect(verdicts("a[[:foo:]]\n", ["a1", "af", "a["])).toEqual(["none", "none", "none"])
    expect(verdicts("a[![:foo:]]\n", ["ab", "a1"])).toEqual(["none", "none"])
    expect(verdicts("a[b\n", ["a[b", "ab"])).toEqual(["none", "none"])
    expect(verdicts("a[\\\n", ["a\\"])).toEqual(["none"])
    expect(verdicts("a[[:digit:]\n", ["a1"])).toEqual(["none"])
  })

  it("reads a `[:` the next `]` does not close with `:]` as a literal `[`", () => {
    expect(verdicts("a[[:digit]b]\n", ["a[b]", "a:b]", "a1"])).toEqual([
      "ignored",
      "ignored",
      "none",
    ])
  })
})
