import type { SessionRecord, Shot } from "./types";
import {
  cloudAppendShot,
  cloudClearShots,
  cloudGetSession,
  cloudListSessions,
  cloudSaveSession,
  canUseCloud,
  fetchCloudStatus,
} from "./cloudClient";

const KEY = "bowl-track-sessions-v1";

function safeParse(raw: string | null): SessionRecord[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

export function listSessions(): SessionRecord[] {
  if (typeof window === "undefined") return [];
  return safeParse(localStorage.getItem(KEY));
}

export function getSession(id: string): SessionRecord | null {
  return listSessions().find((s) => s.id === id) ?? null;
}

export function saveSession(session: SessionRecord): void {
  const all = listSessions();
  const idx = all.findIndex((s) => s.id === session.id);
  const next = { ...session, updatedAt: Date.now() };
  if (idx >= 0) all[idx] = next;
  else all.unshift(next);
  localStorage.setItem(KEY, JSON.stringify(all));
  // 登入＋有 Neon 時背景同步；失敗不影響本機
  void cloudSaveSession(next);
}

export function deleteSession(id: string): void {
  const all = listSessions().filter((s) => s.id !== id);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function createSession(name?: string): SessionRecord {
  const now = Date.now();
  return {
    id: `sess_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: name ?? `球局 ${new Date(now).toLocaleString("zh-HK")}`,
    createdAt: now,
    updatedAt: now,
    corners: null,
    shots: [],
  };
}

export function appendShot(sessionId: string, shot: Shot): SessionRecord | null {
  const s = getSession(sessionId);
  if (!s) return null;
  s.shots = [...s.shots, shot];
  // 本機先寫；雲端用增量 API
  const all = listSessions();
  const idx = all.findIndex((x) => x.id === sessionId);
  const next = { ...s, updatedAt: Date.now() };
  if (idx >= 0) all[idx] = next;
  else all.unshift(next);
  localStorage.setItem(KEY, JSON.stringify(all));
  void cloudAppendShot(sessionId, shot).then((ok) => {
    if (!ok) void cloudSaveSession(next);
  });
  return next;
}

export function clearShots(sessionId: string): SessionRecord | null {
  const s = getSession(sessionId);
  if (!s) return null;
  s.shots = [];
  const next = { ...s, updatedAt: Date.now() };
  const all = listSessions();
  const idx = all.findIndex((x) => x.id === sessionId);
  if (idx >= 0) all[idx] = next;
  localStorage.setItem(KEY, JSON.stringify(all));
  void cloudClearShots(sessionId).then((ok) => {
    if (!ok) void cloudSaveSession(next);
  });
  return next;
}

/**
 * 初始化：若已登入且 Neon 可用，優先雲端；否則／合併後用 localStorage。
 * 雲端球局會寫回 localStorage 作後備。
 */
export async function resolveActiveSession(
  preferredId: string | null
): Promise<SessionRecord> {
  const status = await fetchCloudStatus(true);
  if (canUseCloud(status)) {
    const cloudList = await cloudListSessions();
    if (cloudList && cloudList.length > 0) {
      // 寫回本機後備
      localStorage.setItem(KEY, JSON.stringify(cloudList));
      if (preferredId) {
        const hit =
          cloudList.find((s) => s.id === preferredId) ??
          (await cloudGetSession(preferredId));
        if (hit) return hit;
      }
      return cloudList[0];
    }
  }

  if (preferredId) {
    const local = getSession(preferredId);
    if (local) {
      if (canUseCloud(status)) void cloudSaveSession(local);
      return local;
    }
  }

  const all = listSessions();
  if (all[0]) {
    if (canUseCloud(status)) void cloudSaveSession(all[0]);
    return all[0];
  }

  const created = createSession();
  saveSession(created);
  return created;
}
