import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isDatabaseConfigured } from "@/db";

/** 前端探測：雲端 DB／登入狀態 */
export async function GET() {
  const session = await auth();
  return NextResponse.json({
    database: isDatabaseConfigured(),
    authenticated: Boolean(session?.user?.id),
    user: session?.user
      ? {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
        }
      : null,
  });
}
