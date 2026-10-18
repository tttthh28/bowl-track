import type { SessionRecord, Shot } from "./types";

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
  saveSession(s);
  return s;
}

export function clearShots(sessionId: string): SessionRecord | null {
  const s = getSession(sessionId);
  if (!s) return null;
  s.shots = [];
  saveSession(s);
  return s;
}
