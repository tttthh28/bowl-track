import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { bowlingSessions, shots } from "@/db/schema";
import type { SessionRecord, Shot } from "@/lib/types";

function rowToSession(
  row: typeof bowlingSessions.$inferSelect,
  shotRows: (typeof shots.$inferSelect)[]
): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    corners: row.corners ?? null,
    shots: shotRows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      points: s.points,
      estimate: s.estimate,
      source: s.source,
    })),
  };
}

export async function listSessionsForUser(
  userId: string
): Promise<SessionRecord[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(bowlingSessions)
    .where(eq(bowlingSessions.userId, userId))
    .orderBy(desc(bowlingSessions.updatedAt));

  const result: SessionRecord[] = [];
  for (const row of rows) {
    const shotRows = await db
      .select()
      .from(shots)
      .where(eq(shots.sessionId, row.id))
      .orderBy(shots.createdAt);
    result.push(rowToSession(row, shotRows));
  }
  return result;
}

export async function getSessionForUser(
  userId: string,
  sessionId: string
): Promise<SessionRecord | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(bowlingSessions)
    .where(
      and(
        eq(bowlingSessions.id, sessionId),
        eq(bowlingSessions.userId, userId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const shotRows = await db
    .select()
    .from(shots)
    .where(eq(shots.sessionId, row.id))
    .orderBy(shots.createdAt);
  return rowToSession(row, shotRows);
}

/** 完整 upsert 球局＋投球（以 client payload 為準） */
export async function upsertSessionForUser(
  userId: string,
  session: SessionRecord
): Promise<SessionRecord> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL 未設定");

  const existing = await db
    .select()
    .from(bowlingSessions)
    .where(eq(bowlingSessions.id, session.id))
    .limit(1);

  if (existing[0] && existing[0].userId !== userId) {
    throw new Error("無權覆寫此球局");
  }

  const updatedAt = session.updatedAt || Date.now();

  if (existing[0]) {
    await db
      .update(bowlingSessions)
      .set({
        name: session.name,
        corners: session.corners,
        updatedAt,
      })
      .where(eq(bowlingSessions.id, session.id));
  } else {
    await db.insert(bowlingSessions).values({
      id: session.id,
      userId,
      name: session.name,
      corners: session.corners,
      createdAt: session.createdAt,
      updatedAt,
    });
  }

  // 以 payload 同步 shots：刪除後重插（簡單可靠；單局投球不多）
  await db.delete(shots).where(eq(shots.sessionId, session.id));
  if (session.shots.length > 0) {
    await db.insert(shots).values(
      session.shots.map((s) => ({
        id: s.id,
        sessionId: session.id,
        createdAt: s.createdAt,
        points: s.points,
        estimate: s.estimate,
        source: s.source,
      }))
    );
  }

  return { ...session, updatedAt };
}

export async function appendShotForUser(
  userId: string,
  sessionId: string,
  shot: Shot
): Promise<SessionRecord | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(bowlingSessions)
    .where(
      and(
        eq(bowlingSessions.id, sessionId),
        eq(bowlingSessions.userId, userId)
      )
    )
    .limit(1);
  if (!rows[0]) return null;

  const updatedAt = Date.now();
  await db.insert(shots).values({
    id: shot.id,
    sessionId,
    createdAt: shot.createdAt,
    points: shot.points,
    estimate: shot.estimate,
    source: shot.source,
  });
  await db
    .update(bowlingSessions)
    .set({ updatedAt })
    .where(eq(bowlingSessions.id, sessionId));

  return getSessionForUser(userId, sessionId);
}

export async function clearShotsForUser(
  userId: string,
  sessionId: string
): Promise<SessionRecord | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(bowlingSessions)
    .where(
      and(
        eq(bowlingSessions.id, sessionId),
        eq(bowlingSessions.userId, userId)
      )
    )
    .limit(1);
  if (!rows[0]) return null;

  await db.delete(shots).where(eq(shots.sessionId, sessionId));
  const updatedAt = Date.now();
  await db
    .update(bowlingSessions)
    .set({ updatedAt })
    .where(eq(bowlingSessions.id, sessionId));

  return getSessionForUser(userId, sessionId);
}

export async function deleteSessionForUser(
  userId: string,
  sessionId: string
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select()
    .from(bowlingSessions)
    .where(
      and(
        eq(bowlingSessions.id, sessionId),
        eq(bowlingSessions.userId, userId)
      )
    )
    .limit(1);
  if (!rows[0]) return false;
  await db.delete(bowlingSessions).where(eq(bowlingSessions.id, sessionId));
  return true;
}
