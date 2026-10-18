import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";

function localUserId(email: string): string {
  // 無 DB 時穩定 id（非加密，僅本機 JWT）
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) | 0;
  }
  return `local_${Math.abs(h).toString(36)}_${email.length}`;
}

async function upsertUser(email: string, name?: string) {
  const db = getDb();
  const display =
    name?.trim() || email.split("@")[0] || "球員";

  if (!db) {
    return { id: localUserId(email), email, name: display };
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing[0]) {
    return {
      id: existing[0].id,
      email: existing[0].email,
      name: existing[0].name ?? display,
    };
  }

  const id = `usr_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await db.insert(users).values({
    id,
    email,
    name: display,
  });
  return { id, email, name: display };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // 正式環境請設 AUTH_SECRET；此後備僅供本機／build 無 env 時通過
  secret:
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    "bowl-track-dev-secret-change-me",
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      id: "email",
      name: "電郵登入",
      credentials: {
        email: { label: "電郵", type: "email" },
        name: { label: "顯示名稱", type: "text" },
      },
      async authorize(credentials) {
        const raw = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
          return null;
        }
        const name =
          typeof credentials?.name === "string"
            ? credentials.name
            : undefined;
        const user = await upsertUser(raw, name);
        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.email = (token.email as string) ?? "";
        session.user.name = (token.name as string) ?? null;
      }
      return session;
    },
  },
});
