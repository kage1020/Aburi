import { cookies } from "next/headers"
import { findSession } from "./db"

export async function auth() {
  const token = (await cookies()).get("session")?.value
  if (token === undefined) return null
  return findSession(token)
}
