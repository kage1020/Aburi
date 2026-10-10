import { CoreError } from "../errors"
import { hashRawString } from "./hash"

export function syntaxFingerprint(normalizedAstString: string): string {
  if (normalizedAstString.trim().length === 0) {
    throw new CoreError(
      "syntaxFingerprint received an empty normalized AST string; every missing-AST Symbol would otherwise collapse to the same hash",
      { code: "non-plain-json", value: "" },
    )
  }
  return hashRawString(normalizedAstString)
}
