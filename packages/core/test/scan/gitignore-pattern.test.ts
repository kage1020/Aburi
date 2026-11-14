import { costGrowth } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { MAX_RULE_LENGTH, parseGitignore, type Verdict } from "../../src/scan/gitignore-pattern"

// Every expectation was measured with git itself on the same rules and paths, not read off its
// documentation.
function verdicts(content: string, paths: readonly string[], isDirectory = false): Verdict[] {
  const rules = parseGitignore(Buffer.from(content, "utf8"))
  if (!("decide" in rules)) throw new Error(`line ${rules.line} was refused`)
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

  it.each<[string, string, string, Verdict]>([
    ["a space after an escaped backslash is trailing", "a\\\\ \n", "a\\", "ignored"],
    ["a space after an escaped backslash is not kept", "a\\\\ \n", "a\\ ", "none"],
    ["only one CR is dropped", "a.ts\r\r\n", "a.ts", "none"],
    ["a BOM counts only at the start of the file", "a\n\ufeffb\n", "b", "none"],
    ["the last line needs no newline", "a.ts", "a.ts", "ignored"],
    ["a NUL ends the rule", "foo\0bar\n", "foo", "ignored"],
  ])("%s", (_label, content, path, verdict) => {
    expect(verdicts(content, [path])).toEqual([verdict])
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

  it.each<[string, string, string[]]>([
    ["a.b", "a.b", ["axb"]],
    ["a+b", "a+b", ["aab"]],
    ["(c)", "(c)", ["c"]],
    ["{d}", "{d}", ["d"]],
    ["$e^", "$e^", ["e"]],
    ["f|g", "f|g", ["f", "g"]],
    ["x/a.b", "x/a.b", ["x/axb"]],
    ["x/a+b", "x/a+b", ["x/aab"]],
    ["x/(c)", "x/(c)", ["x/c"]],
  ])("matches `%s` only against itself", (rule, itself, others) => {
    expect(verdicts(`${rule}\n`, [itself, ...others])).toEqual([
      "ignored",
      ...others.map(() => "none"),
    ])
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

  it.each(["**/c.ts", "x/**/c.ts"])(
    "matches `%s` only where whole directories precede `c.ts`",
    (rule) => {
      expect(verdicts(`${rule}\n`, ["ac.ts", "a/bc.ts", "x/ac.ts", "x/a/bc.ts"])).toEqual([
        "none",
        "none",
        "none",
        "none",
      ])
    },
  )

  it("reads `**` before an escaped slash as directories too, without the zero-directory case", () => {
    expect(verdicts("x/**\\/c.ts\n", ["x/a/b/c.ts", "x/c.ts"])).toEqual(["ignored", "none"])
  })

  it.each<[string, string[], Verdict[]]>([
    [
      "foo**/bar",
      ["foobar", "foo/x/bar", "foox/y/bar", "foo/bar", "fooX/bar"],
      ["none", "none", "none", "ignored", "ignored"],
    ],
    ["a**/b", ["a/b", "a/x/b", "ay/x/b"], ["ignored", "none", "none"]],
    ["a**/*", ["a"], ["none"]],
  ])(
    "does not read the `**` of `%s`, right after a literal head, as directories",
    (rule, paths, expected) => {
      expect(verdicts(`${rule}\n`, paths)).toEqual(expected)
    },
  )

  it("leaves a file ignored under a directory re-included by `!/a**`", () => {
    expect(verdicts("*\n!/a**\n", ["a"], true)).toEqual(["kept"])
    expect(verdicts("*\n!/a**\n", ["a/f"])).toEqual(["ignored"])
  })

  it("matches `src/**/` against directories below src only", () => {
    expect(verdicts("src/**/\n", ["src/a.ts"])).toEqual(["none"])
    expect(verdicts("src/**/\n", ["src/sub", "src"], true)).toEqual(["ignored", "none"])
  })

  it.each<[string, string, Verdict]>([
    ["x/a*b", "x/a/b", "none"],
    ["x/a?b", "x/a/b", "none"],
    ["x/a[/]b", "x/a/b", "none"],
    ["x/a[^c]b", "x/a/b", "none"],
    ["x/a[^c]b", "x/axb", "ignored"],
    ["x/a[.-0]b", "x/a/b", "none"],
    ["x/a[.-0]b", "x/a.b", "ignored"],
    ["a[.-0]b", "a.b", "ignored"],
    ["a[.-0]b", "a0b", "ignored"],
  ])("never lets `*`, `?` or a bracket take a slash: `%s` against %s", (rule, path, verdict) => {
    expect(verdicts(`${rule}\n`, [path])).toEqual([verdict])
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

  it.each<[string, string, Verdict]>([
    ["x\\*/y", "x*/y", "ignored"],
    ["x\\*/y", "xa/y", "none"],
    ["d\\[1\\]/e", "d[1]/e", "ignored"],
    ["d\\[1\\]/e", "d1/e", "none"],
    ["src/\\#x/y", "src/#x/y", "ignored"],
  ])("reads an escape in a path rule's literal part: `%s` against %s", (rule, path, verdict) => {
    expect(verdicts(`${rule}\n`, [path])).toEqual([verdict])
  })
})

describe("brackets", () => {
  it("reads `]` first as a member, and `!` or `^` as negation", () => {
    expect(verdicts("a[]].ts\n", ["a].ts", "a1.ts"])).toEqual(["ignored", "none"])
    expect(verdicts("a[!]]\n", ["a]", "ab"])).toEqual(["none", "ignored"])
    expect(verdicts("a[^x]\n", ["ab", "ax"])).toEqual(["ignored", "none"])
    expect(verdicts("a[\\]]\n", ["a]", "a\\"])).toEqual(["ignored", "none"])
  })

  it("reads ranges as git does: only the first endpoint when reversed, `-` literal at an edge or after a range", () => {
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
    expect(verdicts("a[[:alpha:]][[:alpha:]]\n", ["a\u00e9", "abc"])).toEqual(["none", "ignored"])
  })

  it.each([
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
  ])("reads [[:%s:]] as git's own class", (name, inside, outside) => {
    expect(verdicts(`a[[:${name}:]]\n`, [`a${inside}`, `a${outside}`])).toEqual(["ignored", "none"])
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

describe("what a match costs", () => {
  // Without the abort pruning, each rule costs time exponential in its runs of `*` or `**/`: going
  // from three runs to six multiplies it by hundreds, and git's pruning without ours still takes 50
  // times as long over twelve runs of `**/` as over six. Pruned, doubling the runs leaves the cost
  // about where it was, on a fast runner or a busy one.
  const MAX_GROWTH = 10

  it.each<[string, (runs: number) => [rule: string, path: string], number]>([
    ["a run of `**/`", (runs) => [`${"**/".repeat(runs)}z`, `${"d/".repeat(25)}y`], 6],
    ["`*a` repeated in a basename rule", (runs) => [`${"*a".repeat(runs)}*b`, "a".repeat(40)], 3],
    [
      "`*a` repeated in a path rule",
      (runs) => [`x/${"*a".repeat(runs)}*b`, `x/${"a".repeat(40)}`],
      3,
    ],
    [
      "a rule up to the longest length read, one recursion per `*`",
      (runs) => [`${"*a".repeat(runs)}*b`, "a".repeat(MAX_RULE_LENGTH)],
      MAX_RULE_LENGTH / 4 - 1,
    ],
  ])("decides %s at a cost that does not grow with its runs", (_label, shape, runs) => {
    const decider = (count: number): (() => void) => {
      const [rule, path] = shape(count)
      const rules = parseGitignore(Buffer.from(`${rule}\n`, "utf8"))
      if (!("decide" in rules)) throw new Error(`${rule} was refused`)
      expect(rules.decide(path, false)).toBe("none")
      return () => rules.decide(path, false)
    }

    const { median, ratios } = costGrowth(decider(runs), decider(runs * 2))

    expect(
      median,
      `cost ratios at twice the runs: ${ratios.map((r) => r.toFixed(1)).join(", ")}`,
    ).toBeLessThan(MAX_GROWTH)
  })
})
