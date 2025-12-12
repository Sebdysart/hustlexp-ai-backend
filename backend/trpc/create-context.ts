// backend/trpc/create-context.ts

import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

import { adminAuth } from "../auth/firebase";
import { redis, CACHE_KEYS } from "../cache/redis";

export const createContext = async (opts: FetchCreateContextFnOptions) => {
  const req = opts.req;
  const authHeader = req.headers.get("authorization");

  let user = null;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    if (token.length > 10) {
      // Try session cache first
      const cached = await redis.get<string>(CACHE_KEYS.sessionToken(token));
      if (cached) {
        user = JSON.parse(cached);
      } else {
        try {
          const decoded = await adminAuth.verifyIdToken(token);

          user = {
            uid: decoded.uid,
            email: decoded.email || "",
            emailVerified: decoded.email_verified ?? false,
            name: decoded.name || "",
          };

          await redis.set(
            CACHE_KEYS.sessionToken(token),
            JSON.stringify(user),
            15 * 60
          );
        } catch (err) {
          console.error("❌ Firebase token invalid:", err);
        }
      }
    }
  }

  return {
    req,
    user, // IMPORTANT: make user available inside tRPC
  };
};

export type Context = Awaited<ReturnType<typeof createContext>>;

// tRPC config
const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

// Public routes (no auth required)
export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;

// Protected routes (auth required)
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});
