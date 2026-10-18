import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isDatabaseConfigured } from "@/db";
import {
  clearShotsForUser,
  deleteSessionForUser,
  getSessionForUser,
  upsertSessionForUser,
} from "@/lib/sessionRepo";
import type { SessionRecord } from "@/lib/types";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, ctx: Ctx) {
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
  const item = await getSessionForUser(session.user.id, id);
  if (!item) {
    return NextResponse.json({ error: "找不到球局" }, { status: 404 });
  }
  return NextResponse.json({ session: item });
}

export async function PUT(req: Request, ctx: Ctx) {
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
  let body: SessionRecord;
  try {
    body = (await req.json()) as SessionRecord;
  } catch {
    return NextResponse.json({ error: "無效 JSON" }, { status: 400 });
  }
  if (body.id && body.id !== id) {
    return NextResponse.json({ error: "id 不一致" }, { status: 400 });
  }
  body.id = id;
  try {
    const saved = await upsertSessionForUser(session.user.id, body);
    return NextResponse.json({ session: saved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "儲存失敗";
    return NextResponse.json({ error: msg }, { status: 403 });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
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
  const url = new URL(req.url);
  const clearOnly = url.searchParams.get("clearShots") === "1";
  if (clearOnly) {
    const updated = await clearShotsForUser(session.user.id, id);
    if (!updated) {
      return NextResponse.json({ error: "找不到球局" }, { status: 404 });
    }
    return NextResponse.json({ session: updated });
  }
  const ok = await deleteSessionForUser(session.user.id, id);
  if (!ok) {
    return NextResponse.json({ error: "找不到球局" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
