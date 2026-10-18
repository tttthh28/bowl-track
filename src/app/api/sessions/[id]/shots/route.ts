import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isDatabaseConfigured } from "@/db";
import { appendShotForUser } from "@/lib/sessionRepo";
import type { Shot } from "@/lib/types";

type Ctx = { params: { id: string } };

export async function POST(req: Request, ctx: Ctx) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "未設定 DATABASE_URL", fallback: "localStorage" },
      { status: 503 }
    );
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登入" }, { status: 401 });
  }
  const { id } = ctx.params;
  let shot: Shot;
  try {
    shot = (await req.json()) as Shot;
  } catch {
    return NextResponse.json({ error: "無效 JSON" }, { status: 400 });
  }
  if (!shot?.id || !Array.isArray(shot.points) || !shot.estimate) {
    return NextResponse.json({ error: "缺少投球欄位" }, { status: 400 });
  }
  const updated = await appendShotForUser(session.user.id, id, shot);
  if (!updated) {
    return NextResponse.json({ error: "找不到球局" }, { status: 404 });
  }
  return NextResponse.json({ session: updated });
}
