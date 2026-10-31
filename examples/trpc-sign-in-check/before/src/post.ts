import { z } from "zod"
import { prisma } from "./context"
import { protectedProcedure, publicProcedure, router } from "./trpc"

export const listPosts = publicProcedure.query(() => prisma.post.findMany())

export const deletePost = protectedProcedure
  .input(z.object({ id: z.string() }))
  .mutation(({ input }) => prisma.post.delete({ where: { id: input.id } }))

export const postRouter = router({ list: listPosts, delete: deletePost })
