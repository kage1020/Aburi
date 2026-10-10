import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, type GitRunner, runDiff } from "../src"
import { commitAll, fakeGit, initRepository, refusedBy } from "./git"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("diff-ref-diagnosis")

function refusal(refSpec: string, cwd = workspace.root, git?: GitRunner): Promise<CliError> {
  return errorFrom(CliError, () =>
    runDiff({
      cwd,
      refSpec,
      outputDir: resolve(workspace.root, "out"),
      warn: () => {},
      ...(git === undefined ? {} : { git }),
    }),
  )
}

async function repositoryWithACommit(): Promise<void> {
  await initRepository(workspace.root)
  await writeFileAt(workspace.root, "README.md", "demo\n")
  await commitAll(workspace.root)
}

describe("aburi diff — why a ref did not resolve, in a real repository", () => {
  it.each<[string, () => Promise<string>, string, string[], string[]]>([
    [
      "the directory is not a git repository",
      async () => workspace.root,
      "main..HEAD",
      ["Base ref 'main' could not be resolved", "is not inside a git repository", "--base/--head"],
      ["fetch"],
    ],
    [
      "the directory is a git directory rather than a working tree",
      async () => {
        await repositoryWithACommit()
        return resolve(workspace.root, ".git")
      },
      "nosuch..HEAD",
      ["is inside a git directory, not a working tree", "--base/--head"],
      ["fetch"],
    ],
    [
      "the repository has no commits",
      async () => {
        await initRepository(workspace.root)
        return workspace.root
      },
      "main..HEAD",
      ["has no commits yet"],
      ["fetch"],
    ],
    [
      "no revision answers to the base ref",
      async () => {
        await repositoryWithACommit()
        return workspace.root
      },
      "nosuch..HEAD",
      ["Base ref 'nosuch' could not be resolved", "no such revision", "Check the spelling"],
      ["--deepen"],
    ],
    [
      "no revision answers to the head ref",
      async () => {
        await repositoryWithACommit()
        return workspace.root
      },
      "main..nosuch",
      ["Head ref 'nosuch' could not be resolved", "no such revision"],
      [],
    ],
  ])("says when %s, with git's own words, at exit 2", async (_, arrange, refSpec, says, doesNotSay) => {
    const error = await refusal(refSpec, await arrange())

    expect(error.code).toBe("input-error")
    for (const fragment of says) expect(error.message).toContain(fragment)
    for (const fragment of doesNotSay) expect(error.message).not.toContain(fragment)
    expect(error.message).toContain((error.cause as Error).message.trim())
  })
})

describe("aburi diff — a ref git would not explain", () => {
  const GIT_SAID = "fatal: Needed a single revision"

  it("passes git's own report on at exit 1 when it refuses the question inside a repository", async () => {
    await mkdir(resolve(workspace.root, ".git"))
    const said = "fatal: detected dubious ownership in repository"
    const { runner } = fakeGit({
      handlers: {
        "rev-parse --verify": refusedBy(said),
        "rev-parse --is-inside-work-tree": refusedBy(said),
      },
    })

    const error = await refusal("main..HEAD", workspace.root, runner)

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain("Base ref 'main' could not be resolved")
    expect(error.message).toContain(said)
    expect(error.message).not.toContain("is not inside a git repository")
  })

  it("does not call a ref misspelt when git would not say whether there are commits", async () => {
    const { runner } = fakeGit({
      handlers: {
        "rev-parse --verify": refusedBy(GIT_SAID),
        "rev-list --all": refusedBy("fatal: bad object HEAD"),
      },
    })

    const error = await refusal("main..HEAD", workspace.root, runner)

    expect(error.code).toBe("runtime-error")
    expect(error.message).not.toContain("no such revision")
    expect(error.message).not.toContain("has no commits")
    expect(error.message).toContain(GIT_SAID)
  })

  it("reports a git that cannot be started as a missing installation, not a missing ref", async () => {
    const missing: GitRunner = {
      async run() {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })
      },
    }

    const error = await refusal("main..HEAD", workspace.root, missing)

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain("git executable not found in PATH")
  })

  it("asks the diagnosing questions only once a ref has failed", async () => {
    const healthy = fakeGit({ handlers: { "worktree add": refusedBy("stop here") } })
    await runDiff({
      cwd: workspace.root,
      refSpec: "main..HEAD",
      git: healthy.runner,
      warn: () => {},
    }).catch(() => {})
    expect(healthy.asked).toContain("rev-parse --verify")
    expect(healthy.asked).not.toContain("rev-parse --is-inside-work-tree")
    expect(healthy.asked).not.toContain("rev-list --all")

    const failing = fakeGit({ handlers: { "rev-parse --verify": refusedBy(GIT_SAID) } })
    await refusal("main..HEAD", workspace.root, failing.runner)
    expect(failing.asked).toContain("rev-parse --is-inside-work-tree")
    expect(failing.asked).toContain("rev-list --all")
  })
})
