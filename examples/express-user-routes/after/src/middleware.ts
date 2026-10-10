import type { NextFunction, Request, Response } from "express"

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.header("x-role") !== "admin") {
    res.status(403).end()
    return
  }
  next()
}
