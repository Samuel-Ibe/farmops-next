import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authorizeWithCredentials } from "@/lib/credentials";

export const { handlers, signIn, signOut, auth } = NextAuth({
  // Self-hosted deployment: Auth.js only defaults `trustHost` to true in
  // dev (NODE_ENV !== "production") or on Vercel/CF Pages, so every
  // /api/auth/* route returned 500 (UntrustedHost) under `next start` and in
  // the production Docker image. The app is served from one origin (behind a
  // proxy), so trusting the request host here is correct; per-request origin
  // validation for CSRF still applies inside Auth.js.
  trustHost: true,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      // Brute-force throttling lives in @/lib/credentials so it can be
      // unit-tested without initializing NextAuth.
      authorize: authorizeWithCredentials,
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.id = user.id;
        token.farmId = user.farmId;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        // JWT claims arrive as untyped payload fields: narrow before use.
        const id = token.id;
        const sub = token.sub;
        const role = token.role;
        const farmId = token.farmId;
        session.user.id =
          typeof id === "string" ? id : typeof sub === "string" ? sub : "";
        session.user.role = typeof role === "string" ? role : "FIELD_WORKER";
        session.user.farmId = typeof farmId === "string" ? farmId : null;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET,
});
