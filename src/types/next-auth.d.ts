import type { DefaultSession } from "next-auth";

/**
 * Type-safe Auth.js session. `authorize()` returns these extra fields
 * (src/lib/auth.ts), the jwt callback copies them onto the token, and the
 * session callback copies them back onto session.user — no `as any` casts.
 */
declare module "next-auth" {
  interface User {
    role: string;
    farmId: string | null;
  }

  interface Session {
    user: {
      id: string;
      role: string;
      farmId: string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    farmId?: string | null;
  }
}
