import {
  jsonb,
  pgSchema,
  text,
  timestamp,
  bigint,
  index,
} from "drizzle-orm/pg-core";
import type { LaneCorners, ShotEstimate, TrackPoint } from "../lib/types";

/** 與 DreamFinder 共用 Neon 時隔離；唔好寫入 public.users */
export const bowlSchema = pgSchema("bowl_track");

/** 登入用戶（電郵） */
export const users = bowlSchema.table("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** 球局 */
export const bowlingSessions = bowlSchema.table(
  "bowling_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    corners: jsonb("corners").$type<LaneCorners | null>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("bowling_sessions_user_idx").on(t.userId)]
);

/** 一投 */
export const shots = bowlSchema.table(
  "shots",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => bowlingSessions.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    points: jsonb("points").$type<TrackPoint[]>().notNull(),
    estimate: jsonb("estimate").$type<ShotEstimate>().notNull(),
    source: text("source").$type<"camera" | "upload">().notNull(),
  },
  (t) => [index("shots_session_idx").on(t.sessionId)]
);
