/**
 * @throws {ValidationError} when the input is malformed
 */
export function validate(input: string): void {
  if (input.length === 0) throw new Error("empty")
}

export class Repository {
  save(x: string): void {
    validate(x)
  }
  load(): string {
    return "x"
  }
}

export class Service {
  private repo = new Repository()
  handle(x: string): void {
    this.repo.save(x)
    this.helper()
  }
  helper(): void {
    this.repo.load()
  }
}
