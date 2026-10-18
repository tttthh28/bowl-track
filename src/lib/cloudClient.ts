import type { SessionRecord, Shot } from "./types";

export type CloudStatus = {
  database: boolean;
  authenticated: boolean;
  user: { id: string; email: string; name?: string | null } | null;
};

let cachedStatus: CloudStatus | null = null;
let statusFetchedAt = 0;

export async function fetchCloudStatus(
  force = false
): Promise<CloudStatus> {
  const now = Date.now();
  if (!force && cachedStatus && now - statusFetchedAt < 15_000) {
    return cachedStatus;
  }
  try {
    const res = await fetch("/api/cloud", { cache: "no-store" });
    if (!res.ok) {
      cachedStatus = { database: false, authenticated: false, user: null };
    } else {
      cachedStatus = (await res.json()) as CloudStatus;
    }
  } catch {
    cachedStatus = { database: false, authenticated: false, user: null };
  }
  statusFetchedAt = now;
  return cachedStatus;
}

export function canUseCloud(status: CloudStatus): boolean {
  return status.database && status.authenticated;
}

export async function cloudListSessions(): Promise<SessionRecord[] | null> {
  const status = await fetchCloudStatus();
  if (!canUseCloud(status)) return null;
  const res = await fetch("/api/sessions", { cache: "no-store" });
  if (res.status === 503 || res.status === 401) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as { sessions: SessionRecord[] };
  return data.sessions;
}

export async function cloudGetSession(
  id: string
): Promise<SessionRecord | null> {
  const status = await fetchCloudStatus();
  if (!canUseCloud(status)) return null;
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { session: SessionRecord };
  return data.session;
}

export async function cloudSaveSession(
  session: SessionRecord
): Promise<boolean> {
  const status = await fetchCloudStatus();
  if (!canUseCloud(status)) return false;
  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function cloudAppendShot(
  sessionId: string,
  shot: Shot
): Promise<boolean> {
  const status = await fetchCloudStatus();
  if (!canUseCloud(status)) return false;
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/shots`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shot),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function cloudClearShots(sessionId: string): Promise<boolean> {
  const status = await fetchCloudStatus();
  if (!canUseCloud(status)) return false;
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}?clearShots=1`,
      { method: "DELETE" }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function invalidateCloudStatus(): void {
  cachedStatus = null;
  statusFetchedAt = 0;
}
