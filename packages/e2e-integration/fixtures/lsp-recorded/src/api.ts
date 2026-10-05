function Controller(_p: string): ClassDecorator { return () => {} }
function Get(_p: string): MethodDecorator { return () => {} }
@Controller("x")
export class Api {
  @Get("a")
  list(): number {
    return 1
  }
  one(): number {
    return 2
  }
}
export default function () {
  return 3
}
