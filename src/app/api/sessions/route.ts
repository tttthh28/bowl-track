import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isDatabaseConfigured } from "@/db";
import {
  listSessionsForUser,
  upsertSessionForUser,
} from "@/lib/sessionRepo";
import type { SessionRecord } from "@/lib/types";

export async function GET() {
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
  const items = await listSessionsForUser(session.user.id);
  return NextResponse.json({ sessions: items });
}

export async function POST(req: Request) {
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
  let body: SessionRecord;
  try {
    body = (await req.json()) as SessionRecord;
  } catch {
    return NextResponse.json({ error: "無效 JSON" }, { status: 400 });
  }
  if (!body?.id || !body?.name || !Array.isArray(body.shots)) {
    return NextResponse.json({ error: "缺少球局欄位" }, { status: 400 });
  }
  try {
    const saved = await upsertSessionForUser(session.user.id, body);
    return NextResponse.json({ session: saved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "儲存失敗";
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}
