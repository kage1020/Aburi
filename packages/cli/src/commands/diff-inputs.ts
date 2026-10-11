import { CliError } from "../errors"

export interface RefSpec {
  base: string
  head: string
}

export type DiffInputs =
  | { kind: "refs"; spec: RefSpec }
  | { kind: "files"; base: string; head: string }

export function chooseInputs(options: {
  refSpec?: string | null
  base?: string | null
  head?: string | null
}): DiffInputs {
  if (options.refSpec !== undefined && options.refSpec !== null && options.refSpec.length > 0) {
    if (options.base !== undefined && options.base !== null) {
      throw new CliError(
        `--base cannot be combined with a ref spec argument. Use one or the other.`,
        "input-error",
      )
    }
    return { kind: "refs", spec: parseRefSpec(options.refSpec) }
  }
  if (options.base === undefined || options.base === null || options.base.length === 0) {
    throw new CliError(
      `aburi diff needs either <base>..<head> or --base <ir.json> --head <ir.json>.`,
      "input-error",
    )
  }
  if (options.head === undefined || options.head === null || options.head.length === 0) {
    throw new CliError(`--base was supplied without a matching --head <ir.json>.`, "input-error")
  }
  return { kind: "files", base: options.base, head: options.head }
}

function parseRefSpec(spec: string): RefSpec {
  const separator = spec.indexOf("..")
  if (separator === -1) throw malformedRefSpec(spec)
  let afterDots = separator + 2
  while (spec[afterDots] === ".") afterDots++
  const base = spec.slice(0, separator)
  const head = spec.slice(afterDots)
  if (base.length === 0 || head.length === 0) {
    throw new CliError(
      `diff argument "${spec}" must contain non-empty base and head refs on either side of "..".`,
      "input-error",
    )
  }
  if (head.includes("..")) throw malformedRefSpec(spec)
  if (afterDots - separator === 3) {
    throw new CliError(
      `diff argument "${spec}" uses the three-dot form. aburi diff compares the two revisions directly, so write it as "${base}..${head}". To compare the head against the merge base instead, resolve it yourself with: git merge-base <base> <head>.`,
      "input-error",
    )
  }
  if (afterDots - separator !== 2) throw malformedRefSpec(spec)
  return { base, head }
}

function malformedRefSpec(spec: string): CliError {
  return new CliError(
    `diff argument "${spec}" is not a valid ref spec. Use <base>..<head> (e.g. main..HEAD) or supply --base and --head with IR paths.`,
    "input-error",
  )
}
