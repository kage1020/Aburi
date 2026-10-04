export class NotFoundError extends Error {}
export class Repo {
  /**
   * Loads a row.
   * @throws {NotFoundError} when the row is missing
   * @throws RangeError
   * @throws TypeError when id is not an integer
   */
  load(id: number): number {
    if (id < 0) throw new RangeError("neg")
    if (!Number.isInteger(id)) throw new TypeError("int")
    if (id > 100) throw new NotFoundError("x")
    return id
  }
  run(): number {
    return this.load(1)
  }
}
export class Store<T> {
  items: T[] = []
  count(): number { return this.items.length }
  run(): number {
    return this.count() + this.count()
  }
}
export class Factory {
  static create(): Factory { return new Factory() }
  static build(): Factory {
    return this.create()
  }
}
