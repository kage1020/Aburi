export class View {
  helper(): string {
    return "view"
  }
  render() {
    return <div>{this.helper()}</div>
  }
}
