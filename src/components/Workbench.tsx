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
  detectLaneFromCanvas,
  fallbackDefaultCorners,
} from "@/lib/laneDetect";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  getRpmEstimate,
  rgbaToGray,
  shouldEndShot,
  trackBallFrame,
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
  const trackerRef = useRef(new BallTrackerState());
  const trackingRef = useRef(false);
  const shotStartRef = useRef<number>(0);
  const lastFrameTRef = useRef<number>(0);
  const livePointsRef = useRef<TrackPoint[]>([]);
  const cornersRef = useRef<LaneCorners | null>(null);
  const homoRef = useRef<Homography | null>(null);
  const settingsRef = useRef<TrackerSettings>({ ...DEFAULT_TRACKER });
  const sourceModeRef = useRef<SourceMode>("idle");
  const lastVideoTimeRef = useRef<number>(0);
  const finishingRef = useRef(false);

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
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [debugNoise, setDebugNoise] = useState<number | null>(null);

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

  useEffect(() => {
    const existing =
      typeof window !== "undefined"
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

  const persistCorners = useCallback((c: LaneCorners) => {
    setCorners(c);
    setSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, corners: c };
      saveSession(next);
      return next;
    });
  }, []);

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
    setDetectMsg(null);
    setStatus("請拖曳四角或按「自動偵測」；鏡頭需見到 foul～pins");
  }, [persistCorners]);

  const onVideoReady = useCallback(() => {
    setVideoReady(true);
    initCornersFromVideo();
  }, [initCornersFromVideo]);

  const grabFrameToCanvas = useCallback((): HTMLCanvasElement | null => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v || !canvas || !v.videoWidth) return null;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    return canvas;
  }, []);

  const runAutoDetect = useCallback(() => {
    setError(null);
    setDetecting(true);
    setDetectMsg(null);
    try {
      const canvas = grabFrameToCanvas();
      const v = videoRef.current;
      if (!canvas || !v?.videoWidth) {
        setError("尚無影像，請先開啟鏡頭或上傳影片");
        return;
      }
      const result = detectLaneFromCanvas(canvas);
      if (!result) {
        const fb = fallbackDefaultCorners(v.videoWidth, v.videoHeight);
        persistCorners(fb);
        setDetectMsg("自動偵測失敗，已退回預設四角，請手動拖曳");
        setStatus("自動偵測失敗 → 請手動對準 foul～pins");
        return;
      }
      persistCorners(result.corners);
      setDetectMsg(
        `${result.message}（信心 ${(result.confidence * 100).toFixed(0)}%）`
      );
      setStatus(
        result.confidence >= 0.55
          ? "自動偵測完成，可微調藍點後開始追蹤"
          : "自動偵測信心偏低，建議手動調整四角"
      );
      setPhase("calibrate");
    } finally {
      setDetecting(false);
    }
  }, [grabFrameToCanvas, persistCorners]);

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
      ctx.fillStyle = last.predicted ? "#fbbf24" : "#f97316";
      ctx.fill();
    }
  }, []);

  const finishShot = useCallback(() => {
    const points = [...livePointsRef.current];
    livePointsRef.current = [];
    trackerRef.current.lost = 0;
    const travelPx = (() => {
      let d = 0;
      for (let i = 1; i < points.length; i++) {
        d += Math.hypot(
          points[i].image.x - points[i - 1].image.x,
          points[i].image.y - points[i - 1].image.y
        );
      }
      return d;
    })();
    const feetSpan = (() => {
      const ls = points.filter((p) => p.lane).map((p) => p.lane!.feet);
      if (ls.length < 2) return 0;
      return Math.max(...ls) - Math.min(...ls);
    })();
    if (points.length < 5 || travelPx < 28 || feetSpan < 4) {
      setLivePath([]);
      setStatus(
        points.length === 0
          ? "等待球出現…"
          : "軌跡位移不足，已忽略（請點選紫色球，或確認四角／勿鎖導引線）"
      );
      trackerRef.current.beginNewShot();
      finishingRef.current = false;
      return;
    }
    const rpm = getRpmEstimate(trackerRef.current);
    const estimate = computeShotEstimate(points, rpm);
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
    const rpmTxt =
      estimate.rpm != null
        ? ` · RPM ${estimate.rpm}（實驗）`
        : "";
    setStatus(
      `已存一投 · 袋口 ${
        estimate.pocketBoard?.toFixed(1) ?? "—"
      } · ${
        estimate.avgSpeedMph != null
          ? estimate.avgSpeedMph + " mph"
          : "無球速"
      }${rpmTxt}`
    );
    // 保留背景模型，重置本投追蹤狀態（等下一顆球／點選）
    trackerRef.current.beginNewShot();
    finishingRef.current = false;
  }, []);

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
        const now = performance.now();
        const dt =
          lastFrameTRef.current > 0
            ? Math.min(80, now - lastFrameTRef.current)
            : 33;
        lastFrameTRef.current = now;

        // 影片 loop：currentTime 回繞 → 立刻 flush 未完成投
        const vt = v.currentTime;
        const prevVt = lastVideoTimeRef.current;
        if (
          sourceModeRef.current === "upload" &&
          prevVt > 0.4 &&
          vt + 0.35 < prevVt &&
          livePointsRef.current.length > 0 &&
          !finishingRef.current
        ) {
          finishingRef.current = true;
          finishShot();
          lastVideoTimeRef.current = vt;
          drawOverlay();
          return;
        }
        lastVideoTimeRef.current = vt;

        const frame = ctx.getImageData(0, 0, w, h);
        const gray = rgbaToGray(frame.data, w, h);
        const result = trackBallFrame(
          trackerRef.current,
          gray,
          w,
          h,
          settingsRef.current,
          cornersRef.current,
          dt,
          frame.data
        );

        if (livePointsRef.current.length % 10 === 0) {
          setDebugNoise(Math.round(result.noiseLevel));
        }

        // 僅在已鎖定且有偵測／短預測時寫入軌跡（避免鎖導引線亂線）
        const pos = result.smoothed;
        if (
          result.locked &&
          pos &&
          (result.raw != null || result.predicted)
        ) {
          if (livePointsRef.current.length === 0 && !result.predicted) {
            shotStartRef.current = performance.now();
            setStatus("已鎖定球，追蹤中…");
          }
          if (livePointsRef.current.length > 0 || !result.predicted) {
            const t = performance.now() - shotStartRef.current;
            const H = homoRef.current;
            const lane = H ? imageToLane(H, pos) : undefined;
            // 過濾明顯不合理的瞬間跳點（lane 空間）
            const prev = livePointsRef.current[livePointsRef.current.length - 1];
            let accept = true;
            if (prev?.lane && lane && !result.predicted) {
              const dFeet = Math.abs(lane.feet - prev.lane.feet);
              const dBoard = Math.abs(lane.board - prev.lane.board);
              const dtPt = Math.max(1, t - prev.t) / 1000;
              if (dFeet / dtPt > 80 || dBoard > 12) accept = false;
            }
            if (accept) {
              const tp: TrackPoint = {
                image: pos,
                lane,
                t,
                predicted: result.predicted || undefined,
              };
              livePointsRef.current.push(tp);
              if (livePointsRef.current.length % 3 === 0) {
                const path = livePointsRef.current
                  .filter((p) => p.lane)
                  .map((p) => p.lane!);
                setLivePath(path);
                const rpm = getRpmEstimate(trackerRef.current);
                setLiveEstimate(
                  computeShotEstimate(livePointsRef.current, rpm)
                );
              }
            }
          }
        }

        if (
          !finishingRef.current &&
          shouldEndShot(
            trackerRef.current,
            settingsRef.current,
            livePointsRef.current.length > 0
          )
        ) {
          finishingRef.current = true;
          finishShot();
        } else if (
          !result.locked &&
          livePointsRef.current.length > 0 &&
          !finishingRef.current
        ) {
          // 誤鎖解除或尚未再鎖：有足夠位移則存檔，否則丟棄以免污染下一投
          let travel = 0;
          const pts = livePointsRef.current;
          for (let i = 1; i < pts.length; i++) {
            travel += Math.hypot(
              pts[i].image.x - pts[i - 1].image.x,
              pts[i].image.y - pts[i - 1].image.y
            );
          }
          if (travel >= 28 && pts.length >= 5) {
            finishingRef.current = true;
            finishShot();
          } else {
            livePointsRef.current = [];
            setLivePath([]);
            trackerRef.current.beginNewShot();
          }
        }
      } else {
        lastFrameTRef.current = 0;
        lastVideoTimeRef.current = 0;
      }

      drawOverlay();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawOverlay, finishShot]);

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
    const p = clientToVideo(e.clientX, e.clientY);
    if (!p) return;
    // 追蹤中點選＝指定球位置（解鎖誤追導引線／球員）
    if (tracking) {
      livePointsRef.current = [];
      setLivePath([]);
      setLiveEstimate(null);
      trackerRef.current.seedAt(p);
      shotStartRef.current = performance.now();
      setStatus("已點選球位置，開始跟球…");
      return;
    }
    if (phase !== "calibrate") return;
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
    trackerRef.current.reset();
    lastFrameTRef.current = 0;
    setLivePath([]);
    setLiveEstimate(null);
    setPhase("track");
    setTracking(true);
    lastVideoTimeRef.current = 0;
    finishingRef.current = false;
    setStatus(
      "等待紫色／暗色球出現…也可直接點球鎖定；消失或影片重播會自動存檔"
    );
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
    setDetectMsg(null);
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
        <button
          type="button"
          onClick={runAutoDetect}
          disabled={!videoReady || tracking || detecting}
          className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {detecting ? "偵測中…" : "自動偵測球道"}
        </button>
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
      {detectMsg && (
        <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
          {detectMsg}
        </div>
      )}

      <p className="text-sm text-slate-400">
        {status}
        {session && (
          <span className="ml-2 text-slate-600">· {session.name}</span>
        )}
      </p>

      <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
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
                <br />
                （鏡頭需見到 foul line～pins，參考 LaneTrax）
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-slate-200">追蹤靈敏度</span>
              <span className="font-mono text-slate-400">
                {settings.sensitivity}
                {settings.autoSensitivity && debugNoise != null
                  ? ` · 雜訊≈${debugNoise}`
                  : ""}
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
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={settings.autoSensitivity}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      autoSensitivity: e.target.checked,
                    }))
                  }
                  className="accent-sky-500"
                />
                自動微調閾值
              </label>
              <span>
                最小 blob：
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
              </span>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-sky-400 hover:underline"
              >
                {showAdvanced ? "收合進階" : "進階參數"}
              </button>
            </div>

            {showAdvanced && (
              <div className="mt-3 space-y-2 border-t border-slate-800 pt-3 text-[11px] text-slate-400">
                <label className="flex items-center justify-between gap-2">
                  <span>位置平滑 EMA</span>
                  <input
                    type="range"
                    min={15}
                    max={90}
                    value={Math.round(settings.emaAlpha * 100)}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        emaAlpha: Number(e.target.value) / 100,
                      }))
                    }
                    className="w-32 accent-sky-500"
                  />
                  <span className="w-8 font-mono text-slate-300">
                    {settings.emaAlpha.toFixed(2)}
                  </span>
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>背景學習率</span>
                  <input
                    type="range"
                    min={1}
                    max={15}
                    value={Math.round(settings.bgLearningRate * 100)}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        bgLearningRate: Number(e.target.value) / 100,
                      }))
                    }
                    className="w-32 accent-sky-500"
                  />
                  <span className="w-8 font-mono text-slate-300">
                    {settings.bgLearningRate.toFixed(2)}
                  </span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={settings.rpmEnabled}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        rpmEnabled: e.target.checked,
                      }))
                    }
                    className="accent-amber-500"
                  />
                  實驗性 RPM（需球表高對比標記／色塊）
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>RPM 對比門檻</span>
                  <input
                    type="range"
                    min={8}
                    max={40}
                    value={settings.rpmMinContrast}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        rpmMinContrast: Number(e.target.value),
                      }))
                    }
                    className="w-32 accent-amber-500"
                  />
                  <span className="w-8 font-mono text-slate-300">
                    {settings.rpmMinContrast}
                  </span>
                </label>
                <p className="text-[10px] leading-relaxed text-amber-500/80">
                  RPM 為實驗功能：以球表極座標相關估角速度，可靠度受光線、模糊、無標記影響。UI
                  會標信心；請勿當作正式量測。
                </p>
              </div>
            )}

            {phase === "calibrate" && corners && !tracking && (
              <p className="mt-2 text-[11px] text-sky-400/90">
                拖曳藍點對準球道四角（或用自動偵測）：
                {Object.entries(CORNER_LABELS)
                  .map(([k, v]) => `${k.toUpperCase()}=${v}`)
                  .join("；")}
              </p>
            )}
            {tracking && (
              <p className="mt-2 text-[11px] text-orange-300/90">
                追蹤中：偏好圓形紫／暗色球、忽略細長導引線。可點影片上的球強制鎖定；球出球道、到 pin
                區後消失、或影片 loop 回繞時會結束並存檔。
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <LaneMap shots={session?.shots ?? []} livePath={livePath} />
          <ShotStats
            shots={session?.shots ?? []}
            liveEstimate={liveEstimate}
          />
        </div>
      </div>
    </div>
  );
}
