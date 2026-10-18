"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import LaneMap from "./LaneMap";
import ShotStats from "./ShotStats";
import {
  buildHomography,
  defaultCorners,
  imageToLane,
  type Homography,
} from "@/lib/perspective";
import { computeShotEstimate } from "@/lib/estimates";
import {
  cornersBBox,
  DEFAULT_TRACKER,
  findBallCentroid,
  rgbaToGray,
} from "@/lib/tracker";
import {
  appendShot,
  clearShots,
  createSession,
  getSession,
  saveSession,
} from "@/lib/storage";
import type {
  LaneCorners,
  LanePoint,
  Point2D,
  SessionRecord,
  Shot,
  ShotEstimate,
  TrackPoint,
  TrackerSettings,
} from "@/lib/types";

type CornerKey = keyof LaneCorners;
type SourceMode = "idle" | "camera" | "upload";
type Phase = "calibrate" | "track";

const CORNER_LABELS: Record<CornerKey, string> = {
  tl: "左上（pins 左／遠端）",
  tr: "右上（pins 右／遠端）",
  br: "右下（foul 右／近端）",
  bl: "左下（foul 左／近端）",
};

export default function Workbench() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const prevGrayRef = useRef<Uint8ClampedArray | null>(null);
  const trackingRef = useRef(false);
  const lostRef = useRef(0);
  const shotStartRef = useRef<number>(0);
  const livePointsRef = useRef<TrackPoint[]>([]);
  const cornersRef = useRef<LaneCorners | null>(null);
  const homoRef = useRef<Homography | null>(null);
  const settingsRef = useRef<TrackerSettings>({ ...DEFAULT_TRACKER });
  const sourceModeRef = useRef<SourceMode>("idle");

  const [session, setSession] = useState<SessionRecord | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("idle");
  const [phase, setPhase] = useState<Phase>("calibrate");
  const [corners, setCorners] = useState<LaneCorners | null>(null);
  const [dragging, setDragging] = useState<CornerKey | null>(null);
  const [tracking, setTracking] = useState(false);
  const [settings, setSettings] = useState<TrackerSettings>({
    ...DEFAULT_TRACKER,
  });
  const [livePath, setLivePath] = useState<LanePoint[]>([]);
  const [liveEstimate, setLiveEstimate] = useState<ShotEstimate | null>(null);
  const [status, setStatus] = useState("請開啟鏡頭或上傳影片");
  const [videoReady, setVideoReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 同步 refs
  useEffect(() => {
    cornersRef.current = corners;
    homoRef.current = corners ? buildHomography(corners) : null;
  }, [corners]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    trackingRef.current = tracking;
  }, [tracking]);
  useEffect(() => {
    sourceModeRef.current = sourceMode;
  }, [sourceMode]);

  // 初始化 session
  useEffect(() => {
    const existing = typeof window !== "undefined"
      ? localStorage.getItem("bowl-track-active-session")
      : null;
    if (existing) {
      const s = getSession(existing);
      if (s) {
        setSession(s);
        if (s.corners) setCorners(s.corners);
        return;
      }
    }
    const s = createSession();
    saveSession(s);
    localStorage.setItem("bowl-track-active-session", s.id);
    setSession(s);
  }, []);

  const persistCorners = useCallback(
    (c: LaneCorners) => {
      setCorners(c);
      setSession((prev) => {
        if (!prev) return prev;
        const next = { ...prev, corners: c };
        saveSession(next);
        return next;
      });
    },
    []
  );

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const initCornersFromVideo = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = defaultCorners(v.videoWidth, v.videoHeight);
    persistCorners(c);
    setPhase("calibrate");
    setStatus("請拖曳四角對準球道，完成後按「開始追蹤」");
  }, [persistCorners]);

  const onVideoReady = useCallback(() => {
    setVideoReady(true);
    initCornersFromVideo();
  }, [initCornersFromVideo]);

  const startCamera = async () => {
    setError(null);
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      await v.play();
      setSourceMode("camera");
      setStatus("鏡頭已開啟");
      // loadedmetadata may already have fired
      if (v.videoWidth) onVideoReady();
    } catch (e) {
      setError(
        e instanceof Error
          ? `無法開啟鏡頭：${e.message}`
          : "無法開啟鏡頭"
      );
    }
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    stopCamera();
    const url = URL.createObjectURL(file);
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = null;
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.loop = true;
    try {
      await v.play();
      setSourceMode("upload");
      setStatus(`已載入：${file.name}`);
      if (v.videoWidth) onVideoReady();
    } catch (e) {
      setError(
        e instanceof Error ? `無法播放影片：${e.message}` : "無法播放影片"
      );
    }
  };

  // 繪製 overlay（四角 + 軌跡）
  const drawOverlay = useCallback(() => {
    const v = videoRef.current;
    const overlay = overlayRef.current;
    if (!v || !overlay || !v.videoWidth) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const c = cornersRef.current;
    if (c) {
      ctx.beginPath();
      ctx.moveTo(c.tl.x, c.tl.y);
      ctx.lineTo(c.tr.x, c.tr.y);
      ctx.lineTo(c.br.x, c.br.y);
      ctx.lineTo(c.bl.x, c.bl.y);
      ctx.closePath();
      ctx.strokeStyle = "rgba(56, 189, 248, 0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "rgba(56, 189, 248, 0.08)";
      ctx.fill();

      (["tl", "tr", "br", "bl"] as CornerKey[]).forEach((k) => {
        const p = c[k];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = "#0ea5e9";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = "11px sans-serif";
        ctx.fillText(k.toUpperCase(), p.x + 12, p.y - 8);
      });
    }

    const pts = livePointsRef.current;
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].image.x, pts[0].image.y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].image.x, pts[i].image.y);
      }
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    if (pts.length > 0) {
      const last = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(last.image.x, last.image.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#f97316";
      ctx.fill();
    }
  }, []);

  const finishShot = useCallback(() => {
    const points = [...livePointsRef.current];
    livePointsRef.current = [];
    lostRef.current = 0;
    if (points.length < 5) {
      setLivePath([]);
      setStatus("軌跡太短，已忽略（請調靈敏度或確認四角）");
      return;
    }
    const estimate = computeShotEstimate(points);
    const shot: Shot = {
      id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      points,
      estimate,
      source: sourceModeRef.current === "upload" ? "upload" : "camera",
    };
    setLiveEstimate(estimate);
    setLivePath(points.filter((p) => p.lane).map((p) => p.lane!));
    setSession((prev) => {
      if (!prev) return prev;
      const updated = appendShot(prev.id, shot);
      return updated ?? { ...prev, shots: [...prev.shots, shot] };
    });
    setStatus(
      `已存一投 · 袋口 board ${
        estimate.pocketBoard?.toFixed(1) ?? "—"
      } · ${estimate.speedMph != null ? estimate.speedMph + " mph" : "無球速"}`
    );
  }, []);

  // 主迴圈
  useEffect(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const v = videoRef.current;
      const canvas = canvasRef.current;
      if (!v || !canvas || v.readyState < 2 || !v.videoWidth) {
        drawOverlay();
        return;
      }

      const w = v.videoWidth;
      const h = v.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, w, h);

      if (trackingRef.current && cornersRef.current) {
        const frame = ctx.getImageData(0, 0, w, h);
        const gray = rgbaToGray(frame.data, w, h);
        const prev = prevGrayRef.current;
        if (prev && prev.length === gray.length) {
          const roi = cornersBBox(cornersRef.current, 12);
          const centroid = findBallCentroid(
            gray,
            prev,
            w,
            h,
            settingsRef.current,
            roi
          );
          if (centroid) {
            lostRef.current = 0;
            if (livePointsRef.current.length === 0) {
              shotStartRef.current = performance.now();
            }
            const t = performance.now() - shotStartRef.current;
            const H = homoRef.current;
            const lane = H ? imageToLane(H, centroid) : undefined;
            const tp: TrackPoint = { image: centroid, lane, t };
            livePointsRef.current.push(tp);
            // 節流更新 UI
            if (livePointsRef.current.length % 3 === 0) {
              const path = livePointsRef.current
                .filter((p) => p.lane)
                .map((p) => p.lane!);
              setLivePath(path);
              setLiveEstimate(computeShotEstimate(livePointsRef.current));
            }
          } else if (livePointsRef.current.length > 0) {
            lostRef.current += 1;
            if (lostRef.current >= settingsRef.current.lostFramesToEnd) {
              finishShot();
            }
          }
        }
        prevGrayRef.current = gray;
      } else {
        prevGrayRef.current = null;
      }

      drawOverlay();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawOverlay, finishShot]);

  // 角點拖曳
  const clientToVideo = (clientX: number, clientY: number): Point2D | null => {
    const overlay = overlayRef.current;
    if (!overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const hitCorner = (p: Point2D): CornerKey | null => {
    if (!corners) return null;
    const thresh = 28;
    let best: CornerKey | null = null;
    let bestD = thresh;
    (["tl", "tr", "br", "bl"] as CornerKey[]).forEach((k) => {
      const c = corners[k];
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (phase !== "calibrate" || tracking) return;
    const p = clientToVideo(e.clientX, e.clientY);
    if (!p) return;
    const hit = hitCorner(p);
    if (hit) {
      setDragging(hit);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !corners) return;
    const p = clientToVideo(e.clientX, e.clientY);
    if (!p) return;
    const v = videoRef.current;
    if (!v) return;
    const next = {
      ...corners,
      [dragging]: {
        x: Math.max(0, Math.min(v.videoWidth, p.x)),
        y: Math.max(0, Math.min(v.videoHeight, p.y)),
      },
    };
    setCorners(next);
  };

  const onPointerUp = () => {
    if (dragging && corners) {
      persistCorners(corners);
    }
    setDragging(null);
  };

  const startTracking = () => {
    if (!corners) {
      setStatus("請先完成四角標定");
      return;
    }
    if (!buildHomography(corners)) {
      setError("四角無效（可能共線），請重新調整");
      return;
    }
    livePointsRef.current = [];
    lostRef.current = 0;
    prevGrayRef.current = null;
    setLivePath([]);
    setLiveEstimate(null);
    setPhase("track");
    setTracking(true);
    setStatus("追蹤中…球通過後會自動存檔");
  };

  const stopTracking = () => {
    if (livePointsRef.current.length >= 5) {
      finishShot();
    } else {
      livePointsRef.current = [];
      setLivePath([]);
    }
    setTracking(false);
    setPhase("calibrate");
    setStatus("已停止追蹤");
  };

  const resetSession = () => {
    if (!session) return;
    if (!confirm("清除本局所有投球紀錄？")) return;
    const updated = clearShots(session.id);
    setSession(updated);
    livePointsRef.current = [];
    setLivePath([]);
    setLiveEstimate(null);
    setStatus("本局已重設");
  };

  const newSession = () => {
    stopTracking();
    const s = createSession();
    saveSession(s);
    localStorage.setItem("bowl-track-active-session", s.id);
    setSession(s);
    setCorners(null);
    setLivePath([]);
    setLiveEstimate(null);
    setVideoReady(false);
    setSourceMode("idle");
    stopCamera();
    const v = videoRef.current;
    if (v) {
      v.srcObject = null;
      v.removeAttribute("src");
    }
    setStatus("新球局已建立，請開啟鏡頭或上傳影片");
  };

  useEffect(() => {
    return () => {
      stopCamera();
      cancelAnimationFrame(rafRef.current);
    };
  }, [stopCamera]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 pb-24 md:pb-8">
      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={startCamera}
          className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 active:scale-[0.98]"
        >
          開啟鏡頭
        </button>
        <label className="cursor-pointer rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium text-white hover:bg-slate-600">
          上傳影片
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {!tracking ? (
          <button
            type="button"
            onClick={startTracking}
            disabled={!videoReady || !corners}
            className="rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            開始追蹤
          </button>
        ) : (
          <button
            type="button"
            onClick={stopTracking}
            className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500"
          >
            停止追蹤
          </button>
        )}
        <button
          type="button"
          onClick={resetSession}
          className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
        >
          清除投球
        </button>
        <button
          type="button"
          onClick={newSession}
          className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
        >
          新球局
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-700/50 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      <p className="text-sm text-slate-400">
        {status}
        {session && (
          <span className="ml-2 text-slate-600">· {session.name}</span>
        )}
      </p>

      <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
        {/* 影片區 */}
        <div className="space-y-3">
          <div
            className="relative overflow-hidden rounded-xl border border-slate-700 bg-black"
            style={{ touchAction: "none" }}
          >
            <video
              ref={videoRef}
              className="block h-auto w-full"
              playsInline
              muted
              onLoadedMetadata={onVideoReady}
            />
            <canvas
              ref={overlayRef}
              className="absolute inset-0 h-full w-full cursor-crosshair"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            <canvas ref={canvasRef} className="hidden" />
            {!videoReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 p-6 text-center text-sm text-slate-400">
                開啟手機後置鏡頭，或上傳球道側面／後方影片
              </div>
            )}
          </div>

          {/* 靈敏度 */}
          <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-slate-200">追蹤靈敏度</span>
              <span className="font-mono text-slate-400">
                {settings.sensitivity}
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={70}
              value={settings.sensitivity}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  sensitivity: Number(e.target.value),
                }))
              }
              className="w-full accent-sky-500"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              數值越低越敏感（雜訊多時調高）。最小 blob：
              <input
                type="number"
                min={10}
                max={500}
                value={settings.minBlobPixels}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    minBlobPixels: Number(e.target.value) || 40,
                  }))
                }
                className="ml-1 w-14 rounded border border-slate-600 bg-slate-800 px-1 text-slate-200"
              />
            </p>
            {phase === "calibrate" && corners && (
              <p className="mt-2 text-[11px] text-sky-400/90">
                拖曳藍點對準球道四角：
                {Object.entries(CORNER_LABELS)
                  .map(([k, v]) => `${k.toUpperCase()}=${v}`)
                  .join("；")}
              </p>
            )}
          </div>
        </div>

        {/* 側欄 */}
        <div className="flex flex-col gap-3">
          <LaneMap
            shots={session?.shots ?? []}
            livePath={livePath}
          />
          <ShotStats
            shots={session?.shots ?? []}
            liveEstimate={liveEstimate}
          />
        </div>
      </div>
    </div>
  );
}
