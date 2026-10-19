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
  buildTrackHomography,
  defaultCorners,
  imageToLane,
  mappingCornersForTrack,
  smoothDemoPath,
  type Homography,
} from "@/lib/perspective";
import { computeShotEstimate } from "@/lib/estimates";
import { rebuildPlaneConstrainedPath } from "@/lib/trajectory3d";
import {
  detectLaneFromCanvas,
  fallbackDefaultCorners,
  frameHasLaneSignal,
  isNarrowMidLaneWedge,
  looksLikeBroadcastLane,
  scoreLaneGeometry,
  snapCornersToTrueGutter,
  voteFoulYAcrossFrames,
} from "@/lib/laneDetect";
import { pickBestCornersByProbe } from "@/lib/laneProbe";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  ballContactPoint,
  getRpmEstimate,
  insetLaneCorners,
  rgbaToGray,
  scaleLaneCorners,
  shouldEndShot,
  trackBallFrame,
  trackWorkSize,
} from "@/lib/tracker";
import {
  evaluateShotQuality,
  isDuplicateOfLastShot,
} from "@/lib/shotQuality";
import {
  appendShot,
  clearShots,
  createSession,
  resolveActiveSession,
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
  /** 追蹤用縮圖 buffer（高於 TRACK_WORK_MAX_WIDTH 時） */
  const trackBufRef = useRef<HTMLCanvasElement | null>(null);
  /** 目前追蹤座標相對原影像嘅 scale（seedAt 要用） */
  const trackScaleRef = useRef(1);
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
  /** upload：追蹤上限 ~15fps；同幀／過密 30fps 會鎖右溝 arr~32 */
  const lastTrackedVtRef = useRef<number>(-1);
  /** upload：連續拒溝後解鎖重追 */
  const gutterRejectStreakRef = useRef(0);
  /** PBA：本投是否見過左規 board≥24（真球箭頭區） */
  const pbaSawHighBoardRef = useRef(false);
  /** bowling-demo：inset 搜球避開溝邊；中段鎖穩後切回全角追 pocket */
  const demoInsetActiveRef = useRef(true);
  /** bowling-demo：中段 lost 前進 softRelock 只用一次／投 */
  const midRecoverUsedRef = useRef(0);
  const finishingRef = useRef(false);
  /** 存檔後冷卻，避免短投連存 */
  const shotCooldownUntilRef = useRef(0);
  /** 上傳影片：本圈 loop 是否已存過一投 */
  const loopCycleSavedRef = useRef(false);
  /** 停止追蹤時只 flush 一次 */
  const stopFlushDoneRef = useRef(false);
  /** 上一投（去重） */
  const lastSavedShotRef = useRef<{
    points: TrackPoint[];
    createdAt: number;
  } | null>(null);
  /** LOCAL debug: last finishShot payload for UI-faithful dumps */
  const lastDebugShotRef = useRef<{
    estimate: ShotEstimate;
    n: number;
    boardsSample: string;
    pba: boolean;
  } | null>(null);
  /** 本圈 loop 世代（回繞時 +1） */
  const loopGenRef = useRef(0);
  /** 已存檔嘅 loop 世代；同世代唔可再存 */
  const savedLoopGenRef = useRef(-1);
  /** 避免 setState updater 內副作用（Strict Mode 會雙寫） */
  const sessionRef = useRef<SessionRecord | null>(null);
  /** 上次偵測到回繞嘅 performance.now，防抖 */
  const lastRewindAtRef = useRef(0);

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
    // H 用去 skew 映射梯形；畫面四角仍畫真溝（視覺 bar）
    homoRef.current = corners ? buildTrackHomography(corners) : null;
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
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const preferred =
        typeof window !== "undefined"
          ? localStorage.getItem("bowl-track-active-session")
          : null;
      const s = await resolveActiveSession(preferred);
      if (cancelled) return;
      localStorage.setItem("bowl-track-active-session", s.id);
      setSession(s);
      if (s.corners) setCorners(s.corners);
    })();
    return () => {
      cancelled = true;
    };
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

  const runAutoDetect = useCallback(async () => {
    setError(null);
    setDetecting(true);
    setDetectMsg(null);
    const v = videoRef.current;
    if (!v?.videoWidth) {
      setError("尚無影像，請先開啟鏡頭或上傳影片");
      setDetecting(false);
      return;
    }
    const wasPaused = v.paused;
    const restoreT = v.currentTime;
    // 用 src／duration 判斷上傳片，唔好只信可能未 sync 嘅 sourceModeRef
    const isUpload =
      sourceModeRef.current === "upload" ||
      (!!v.src && !v.srcObject && Number.isFinite(v.duration) && v.duration > 0.5);

    const seekTo = (t: number) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          v.removeEventListener("seeked", onSeeked);
          resolve();
        };
        const onSeeked = () => {
          // 等一幀再抓，減少黑幀
          const rvfc = (
            v as HTMLVideoElement & {
              requestVideoFrameCallback?: (cb: () => void) => number;
            }
          ).requestVideoFrameCallback;
          if (typeof rvfc === "function") {
            rvfc.call(v, () => finish());
            setTimeout(finish, 280);
          } else {
            setTimeout(finish, 40);
          }
        };
        v.addEventListener("seeked", onSeeked);
        try {
          const target = Math.max(
            0,
            Math.min(t, (v.duration || t) - 0.05)
          );
          // 同時間唔觸發 seeked：仍等一小段再抓
          if (Math.abs(v.currentTime - target) < 0.03) {
            setTimeout(finish, 50);
            return;
          }
          v.currentTime = target;
        } catch {
          finish();
          return;
        }
        // 有啲瀏覽器慢 seek／唔觸發 seeked
        setTimeout(finish, 450);
      });

    try {
      // 上傳片：暫停 + multi-seek，用幾何分揀；略過空白幀
      if (isUpload && !wasPaused) {
        try {
          v.pause();
        } catch {
          /* ignore */
        }
      }
      const dur =
        Number.isFinite(v.duration) && v.duration > 1 ? v.duration : 0;
      const tryTimes =
        isUpload && dur > 0
          ? Array.from(
              new Set(
                [
                  0.08,
                  Math.min(0.35, dur * 0.04),
                  Math.min(0.8, dur * 0.1),
                  Math.min(1.4, dur * 0.16),
                  Math.min(dur * 0.28, dur - 0.12),
                  Math.min(dur * 0.42, dur - 0.12),
                  Math.min(dur * 0.58, dur - 0.12),
                  Math.min(dur * 0.72, dur - 0.12),
                  Math.min(dur * 0.85, dur - 0.08),
                  Math.min(dur * 0.92, dur - 0.06),
                  restoreT > 0.2 ? restoreT : dur * 0.2,
                ].map((x) =>
                  Math.max(0, Math.min(x, Math.max(0, dur - 0.06)))
                )
              )
            )
          : [restoreT, Math.max(0, restoreT - 0.15), restoreT + 0.1];

      let result: ReturnType<typeof detectLaneFromCanvas> = null;
      let bestScore = -1e9;
      let attempts = 0;
      let blankSkips = 0;
      type DetCand = {
        det: NonNullable<ReturnType<typeof detectLaneFromCanvas>>;
        geom: number;
      };
      const detCands: DetCand[] = [];
      for (const tSeek of tryTimes) {
        if (isUpload && dur > 0) {
          await seekTo(tSeek);
        } else if (!isUpload) {
          // 鏡頭：連抓幾幀等曝光穩
          await new Promise((r) => setTimeout(r, 30));
        }
        const canvas = grabFrameToCanvas();
        if (!canvas) continue;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) continue;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (!frameHasLaneSignal(img.data, canvas.width, canvas.height)) {
          blankSkips++;
          continue;
        }
        attempts++;
        const next = detectLaneFromCanvas(canvas);
        if (next) {
          const sc = scoreLaneGeometry(next, v.videoWidth, v.videoHeight);
          detCands.push({ det: next, geom: sc });
          if (sc > bestScore) {
            bestScore = sc;
            result = next;
          }
        }
        // Corra 唔再塞入 upload 候選（snap 後同亮段搶 topN → live arr=—／21）
        // 單獨指標仍可由 detectLaneCornersCorra 腳本驗
        // 上傳片要餵探針：唔好提早停，否則只剩首幀壞角（med~6.7 arr=— → UI arrows~21）
        // 鏡頭即時仍可提早停
        if (
          !isUpload &&
          next &&
          next.confidence >= 0.65 &&
          scoreLaneGeometry(next, v.videoWidth, v.videoHeight) >= 92
        )
          break;
      }
      // 多候選再排：單道寬＋中線近中央（避 geom 高但底邊吞鄰道／人 → arrows 卡 ~33.6）
      const vw = v.videoWidth || 1;
      type Ranked = DetCand & { rank: number };
      const ranked: Ranked[] = detCands.map((c) => {
        const corners = c.det.corners;
        const botW = corners.br.x - corners.bl.x;
        const botFrac = botW / vw;
        const midBot = (corners.bl.x + corners.br.x) / 2;
        const midFrac = Math.abs(midBot / vw - 0.5);
        const isBcast =
          !!c.det.broadcastHud || looksLikeBroadcastLane(corners, vw);
        // 廣播真溝 bot≈0.20–0.30 mid≈0.32–0.42；薄楔（<0.17）／過左 mid 重罰
        // demo 真溝≈0.50–0.58
        const widthOk = isBcast
          ? botFrac >= 0.18 && botFrac <= 0.32
            ? 42
            : botFrac >= 0.16 && botFrac <= 0.36
              ? 24
              : botFrac >= 0.14 && botFrac <= 0.4
                ? 8
                : -28
          : botFrac >= 0.5 && botFrac <= 0.58
            ? 36
            : botFrac >= 0.46 && botFrac < 0.5
              ? 24
              : botFrac >= 0.4 && botFrac <= 0.62
                ? 10
                : botFrac >= 0.32 && botFrac <= 0.65
                  ? 2
                  : -35;
        // 真溝 mid≈0.47；廣播 mid≈0.32–0.42；右偏（吸 HUD）／過左薄楔重罰
        const midRightPen = isBcast
          ? midBot / vw > 0.52
            ? -40
            : midBot / vw > 0.48
              ? -18
              : midBot / vw < 0.28
                ? -30
                : midBot / vw < 0.3
                  ? -12
                  : 0
          : midBot / vw > 0.54
            ? -18
            : midBot / vw > 0.52
              ? -8
              : 0;
        const midOk = isBcast
          ? midBot / vw >= 0.28 && midBot / vw <= 0.46
            ? 28
            : midBot / vw >= 0.24 && midBot / vw <= 0.5
              ? 12
              : -28
          : (midFrac < 0.08 ? 22 : midFrac < 0.14 ? 10 : midFrac < 0.2 ? 0 : -30) +
            midRightPen;
        const bcastBonus = isBcast ? 30 : 0;
        const thinWedgePen = isBcast && botFrac < 0.17 ? -40 : 0;
        const hudEdgePen =
          corners.br.x / vw > 0.72 || corners.tr.x / vw > 0.78 ? -50 : 0;
        const pinYf =
          (corners.tl.y + corners.tr.y) / 2 / Math.max(1, v.videoHeight || 1);
        const foulYf =
          (corners.bl.y + corners.br.y) / 2 / Math.max(1, v.videoHeight || 1);
        const extentF = foulYf - pinYf;
        const taperF =
          (corners.tr.x - corners.tl.x) / Math.max(1, botW);
        const midWedge = isNarrowMidLaneWedge(
          corners,
          vw,
          Math.max(1, v.videoHeight || 1)
        );
        const maskPen =
          midWedge
            ? -120
            : isBcast && extentF < 0.36 && taperF > 0.65 && botFrac < 0.34
              ? -90
              : isBcast && extentF < 0.4 && botFrac < 0.28 && taperF > 0.75
                ? -55
                : 0;
        return {
          ...c,
          rank:
            c.geom +
            widthOk +
            midOk +
            bcastBonus +
            hudEdgePen +
            midRightPen +
            thinWedgePen +
            maskPen,
        };
      });
      ranked.sort((a, b) => b.rank - a.rank);
      const usable = ranked.filter(
        (r) =>
          r.rank > -40 &&
          !isNarrowMidLaneWedge(
            r.det.corners,
            vw,
            Math.max(1, v.videoHeight || 1)
          )
      );
      if (usable.length >= 1) {
        const top = usable[0].det;
        const vh = Math.max(1, v.videoHeight || 1);
        const pinYs = (top.corners.tl.y + top.corners.tr.y) / 2 / vh;
        const foulYs = (top.corners.bl.y + top.corners.br.y) / 2 / vh;
        const ext = foulYs - pinYs;
        const bW = top.corners.br.x - top.corners.bl.x;
        const tW = top.corners.tr.x - top.corners.tl.x;
        const tap = tW / Math.max(1, bW);
        const bF = bW / vw;
        const looksMask =
          isNarrowMidLaneWedge(top.corners, vw, vh) ||
          ((!!top.broadcastHud || looksLikeBroadcastLane(top.corners, vw)) &&
            ext < 0.36 &&
            tap > 0.65 &&
            bF < 0.34);
        // Prefer fail→manual over locking mid-wedge (CLEAR stale result)
        if (!looksMask) {
          const snapped =
            top.broadcastHud || looksLikeBroadcastLane(top.corners, vw)
              ? top.corners
              : snapCornersToTrueGutter(
                  top.corners,
                  v.videoWidth,
                  v.videoHeight
                );
          result = {
            ...top,
            corners: snapped,
          };
          bestScore = usable[0].rank;
        } else {
          result = null;
          bestScore = -1e9;
        }
      } else if (ranked.length >= 1) {
        // All candidates mid-wedge / low rank → fail-open
        result = null;
        bestScore = -1e9;
      }

      // 上傳片：先抓連續幀 buffer（~15fps），再用共用探針揀角
      // （舊版疏 seek 會令 tracker 永不 lock → 探針形同虛設 → UI 仍用幾何角 → arrows~21）
      // foul Y 投票移到探針之後：有合格 arrows 時唔改（防拧 H → arr≈28.5）
      let probeNote = "";
      let probeArrowsGood = false;
      if (isUpload && dur > 0 && ranked.length >= 1) {
        const probeFps = 15;
        const probeN = Math.min(90, Math.max(40, Math.floor(Math.min(dur, 6.5) * probeFps)));
        const t0 = Math.min(0.35, Math.max(0.08, dur * 0.04));
        const frames: { rgba: Uint8ClampedArray; width: number; height: number }[] = [];
        for (let i = 0; i < probeN; i++) {
          const tP = Math.min(dur - 0.06, t0 + i / probeFps);
          await seekTo(tP);
          const canvas = grabFrameToCanvas();
          if (!canvas) continue;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) continue;
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (!frameHasLaneSignal(img.data, canvas.width, canvas.height)) continue;
          // 拷貝，避免 ImageData 被下一幀覆寫
          frames.push({
            rgba: new Uint8ClampedArray(img.data),
            width: canvas.width,
            height: canvas.height,
          });
        }
        if (frames.length >= 20) {
          const picked = pickBestCornersByProbe(
            ranked.map((c) => ({ det: c.det, geomRank: c.rank })),
            frames,
            10
          );
          if (picked) {
            // 再 snap：demo 鎖真溝；廣播片保留探針／擬合（避 HUD）
            const pc = picked.det.corners;
            const vhP = Math.max(1, v.videoHeight || 1);
            const extP =
              (pc.bl.y + pc.br.y) / 2 / vhP - (pc.tl.y + pc.tr.y) / 2 / vhP;
            const bFp = (pc.br.x - pc.bl.x) / v.videoWidth;
            const tapP =
              (pc.tr.x - pc.tl.x) / Math.max(1, pc.br.x - pc.bl.x);
            const maskP =
              isNarrowMidLaneWedge(pc, v.videoWidth, vhP) ||
              (!!picked.det.broadcastHud &&
                extP < 0.36 &&
                tapP > 0.65 &&
                bFp < 0.34);
            if (!maskP) {
            const keepBcast =
              picked.det.broadcastHud ||
              looksLikeBroadcastLane(pc, v.videoWidth);
            result = {
              ...picked.det,
              corners: keepBcast
                ? pc
                : snapCornersToTrueGutter(pc, v.videoWidth, v.videoHeight),
            };
            bestScore = picked.detail.score;
            } else {
              // Mid-wedge from probe → fail-open (do not keep prior auto lock)
              result = null;
              bestScore = -1e9;
            }
            const pa = picked.detail.arrows;
            const tonyBand =
              pa != null && pa >= 12.5 && pa <= 15.5;
            probeArrowsGood =
              tonyBand ||
              (pa != null &&
                pa >= 6 &&
                pa <= 20 &&
                !(pa >= 19 && pa <= 22.5) &&
                !picked.detail.gutterRace);
            probeNote = ` · 探針${frames.length}幀 arr=${
              pa != null ? pa.toFixed(1) : "—"
            } med=${
              picked.detail.med != null ? picked.detail.med.toFixed(1) : "—"
            }`;
          }
        } else {
          probeNote = ` · 探針幀不足(${frames.length})`;
        }
      }

      // Black-Lights foul Y：只喺探針無合格 arrows 時微調（有好 arr 時改 foul 會拧透視）
      if (result && ranked.length >= 2 && !probeArrowsGood) {
        const vh = v.videoHeight || 1;
        const foulYs = ranked
          .slice(0, Math.min(6, ranked.length))
          .map((c) => (c.det.corners.bl.y + c.det.corners.br.y) / 2);
        const voted = voteFoulYAcrossFrames(foulYs, vh);
        if (voted != null) {
          const cur =
            (result.corners.bl.y + result.corners.br.y) / 2;
          if (Math.abs(voted - cur) <= vh * 0.025) {
            result = {
              ...result,
              corners: {
                ...result.corners,
                bl: { ...result.corners.bl, y: voted },
                br: { ...result.corners.br, y: voted },
              },
            };
          }
        }
      }

      // 還原播放位置
      if (isUpload && dur > 0) {
        await seekTo(restoreT);
        if (!wasPaused) {
          try {
            void v.play();
          } catch {
            /* ignore */
          }
        }
      }

      // 幾何太差／mid-wedge 先當失敗（唔好用假梯形當成功）
      if (
        result &&
        isNarrowMidLaneWedge(
          result.corners,
          v.videoWidth || 1,
          v.videoHeight || 1
        )
      ) {
        result = null;
        bestScore = -1e9;
      }
      const accept =
        result &&
        (bestScore >= 55 || result.confidence >= 0.45);
      if (!accept) {
        const fb = fallbackDefaultCorners(v.videoWidth, v.videoHeight);
        persistCorners(fb);
        setDetectMsg(
          `自動偵測失敗${blankSkips ? `（略過空白 ${blankSkips}）` : ""}，已退回預設四角，請手動拖曳`
        );
        setStatus("自動偵測失敗 → 請手動對準 foul～pins");
        return;
      }
      persistCorners(result!.corners);
      setDetectMsg(
        `${result!.message}（信心 ${(result!.confidence * 100).toFixed(0)}% · ${attempts}幀${probeNote}）`
      );
      setStatus(
        result!.confidence >= 0.55
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

    const now = performance.now();
    const discard = (reason: string) => {
      setLivePath([]);
      setStatus(reason);
      trackerRef.current.beginNewShot();
      finishingRef.current = false;
    };

    // 上傳：本圈世代已存過則不再存
    if (
      sourceModeRef.current === "upload" &&
      savedLoopGenRef.current === loopGenRef.current
    ) {
      discard("本圈已存一投，等待影片重播…");
      return;
    }
    // 冷卻中：丟棄多餘短投
    if (now < shotCooldownUntilRef.current) {
      discard("冷卻中，已忽略多餘短投");
      return;
    }

    // bowling-demo：存檔前平滑尖角（UI 圖同估計一致；PBA 唔動）
    const pbaEarly = !!settingsRef.current.boardFromRight;
    const pointsForSave =
      sourceModeRef.current === "upload" && !pbaEarly
        ? smoothDemoPath(points)
        : points;

    const q = evaluateShotQuality(pointsForSave);
    if (!q.ok) {
      discard(
        pointsForSave.length === 0
          ? "等待球出現…"
          : `軌跡不足已忽略（${q.reason}／${q.feetSpan.toFixed(1)}′／${(
              q.durationMs / 1000
            ).toFixed(2)}s；請點紫球或確認四角）`
      );
      return;
    }

    // bowling-demo：拒中段短碎（TesterManual r6: densify 後仍存 18–35′）
    // 要 foul→pins 先存，Arr 先有 ~15′ 樣本可對 path。
    if (sourceModeRef.current === "upload" && !pbaEarly) {
      const rawFeet = pointsForSave
        .filter((pt) => pt.lane && !pt.predicted)
        .map((pt) => pt.lane!.feet);
      if (rawFeet.length >= 2) {
        const minF = Math.min(...rawFeet);
        const maxF = Math.max(...rawFeet);
        if (minF > 10 || maxF < 48) {
          discard(
            `覆蓋不足已忽略（${minF.toFixed(0)}–${maxF.toFixed(0)}′，需 foul→pins）`
          );
          return;
        }
      }
    }

    const last = lastSavedShotRef.current;
    if (
      isDuplicateOfLastShot(
        pointsForSave,
        last?.points,
        last?.createdAt,
        Date.now()
      )
    ) {
      discard("與上一投過近，已去重");
      return;
    }

    const rpm = getRpmEstimate(trackerRef.current);
    const pbaMode = !!settingsRef.current.boardFromRight;
    // bowling-demo only：剔 foul 區溝爬頭；保留 12–25′（舊 ≥25′ 門檻會令覆蓋變 27–39′）
    // PBA 手動路徑唔修剪（否則 Arrows／BP —）
    let estPoints = pointsForSave;
    if (sourceModeRef.current === "upload" && !pbaMode) {
      const trimmed = pointsForSave.filter(
        (p) =>
          !p.lane ||
          p.lane.feet >= 12 ||
          (p.lane.board > 5.5 && p.lane.board < 22)
      );
      if (trimmed.filter((p) => p.lane).length >= 8) estPoints = trimmed;
    }
    // Alinejad-port: plane-constrained rebuild from image + H (manual corners)
    // bowling-demo: skip rebuild — densify knots have synthetic image coords;
    // reprojecting them shifts boards away from LaneMap (TesterManual r5 Arr≠path).
    // Estimate must use the same pointsForSave path the map draws.
    const Hfinish = homoRef.current;
    if (pbaMode && Hfinish && estPoints.length >= 4) {
      const rebuilt = rebuildPlaneConstrainedPath(estPoints, Hfinish, {
        reproject: true,
        maxBoardJump: 8,
        maxFeetBack: 2.5,
      });
      if (rebuilt.points.filter((pt) => pt.lane).length >= 6) {
        estPoints = rebuilt.points;
      }
    }
    const estimate = computeShotEstimate(estPoints, rpm, {
      boardFromRight: pbaMode,
    });
    // PBA：只存合理箭頭帶 Arr∈[6,17.5]（殺 mid-dump 19.9／Arr—／溝邊假值）
    // 01 BP— 可接受；10 要靠真球鎖先有 Arr~14。唔夠格就清軌再追，唔標本圈已存。
    if (pbaMode) {
      const arr = estimate.arrowsBoard;
      const arrOk = arr != null && arr >= 6 && arr <= 17.5;
      if (!arrOk) {
        setLivePath([]);
        setStatus(
          arr == null
            ? "PBA 箭頭不足已忽略，繼續追蹤…"
            : `PBA 箭頭異常（${arr}）已忽略，繼續追蹤…`
        );
        pbaSawHighBoardRef.current = false;
        gutterRejectStreakRef.current = 0;
        trackerRef.current.beginNewShot({ clearBg: true });
        finishingRef.current = false;
        return;
      }
    }
    const shot: Shot = {
      id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      points: pointsForSave,
      estimate,
      source: sourceModeRef.current === "upload" ? "upload" : "camera",
    };
    // 先鎖本圈／冷卻，再 append——避免 RAF 同幀連存 6 投
    lastSavedShotRef.current = { points: pointsForSave, createdAt: shot.createdAt };
    shotCooldownUntilRef.current = now + 2800;
    if (sourceModeRef.current === "upload") {
      loopCycleSavedRef.current = true;
      savedLoopGenRef.current = loopGenRef.current;
    }
    setLiveEstimate(estimate);
    {
      const oriented = pointsForSave
        .filter((p) => p.lane && !p.predicted)
        .slice(0, 40)
        .map((p) => `${p.lane!.feet.toFixed(1)}L${p.lane!.board.toFixed(1)}`)
        .join("|");
      lastDebugShotRef.current = {
        estimate,
        n: pointsForSave.length,
        boardsSample: oriented,
        pba: pbaMode,
      };
      if (typeof window !== "undefined") {
        (window as unknown as { __bowlLastShot?: unknown }).__bowlLastShot =
          lastDebugShotRef.current;
      }
    }
    setLivePath(pointsForSave.filter((p) => p.lane).map((p) => p.lane!));
    // appendShot 唔可以放 setState updater（Strict Mode 會跑兩次 → 成對重複）
    const sid = sessionRef.current?.id;
    if (sid) {
      const updated = appendShot(sid, shot);
      if (updated) {
        sessionRef.current = updated;
        setSession(updated);
      } else {
        setSession((prev) => {
          if (!prev) return prev;
          const next = { ...prev, shots: [...prev.shots, shot] };
          sessionRef.current = next;
          return next;
        });
      }
    }
    const covTxt =
      estimate.coverageFeetMax != null
        ? ` · 覆蓋～${estimate.coverageFeetMax}′`
        : "";
    const rpmTxt =
      estimate.rpm != null ? ` · RPM ${estimate.rpm}（實驗）` : "";
    const pocketLabel =
      estimate.pocketBoard != null
        ? `${estimate.pocketBoard.toFixed(1)}${
            estimate.extrapolated?.pocket ? "外推" : ""
          }`
        : "—";
    setStatus(
      `已存一投 · 袋口 ${pocketLabel} · ${
        estimate.avgSpeedMph != null
          ? estimate.avgSpeedMph + " mph"
          : "無球速"
      }${covTxt}${rpmTxt}`
    );
    trackerRef.current.beginNewShot({
      clearBg: sourceModeRef.current === "upload",
    });
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
        // 影片 loop：必須「近尾→近頭」；唔好用單純時間回跳（易誤觸發再開一世代）
        const vt = v.currentTime;
        const prevVt = lastVideoTimeRef.current;
        // upload：用影片時間做 dt／軌跡 t（唔用 wall clock——headless／變速會令球速炸掉）
        let dt: number;
        if (sourceModeRef.current === "upload" && prevVt > 0 && vt >= prevVt) {
          dt = Math.min(80, Math.max(1, (vt - prevVt) * 1000));
        } else {
          dt =
            lastFrameTRef.current > 0
              ? Math.min(80, now - lastFrameTRef.current)
              : 33;
        }
        lastFrameTRef.current = now;
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        const nearEnd = dur > 0 ? prevVt > dur * 0.55 : prevVt > 4;
        const nearStart = vt < Math.min(1.25, dur > 0 ? dur * 0.18 : 1.25);
        const bigBackJump =
          dur > 0 && prevVt - vt > Math.max(2.5, dur * 0.35) && nearStart;
        const loopRewound =
          sourceModeRef.current === "upload" &&
          prevVt > 1.5 &&
          nearEnd &&
          (nearStart || bigBackJump) &&
          performance.now() - lastRewindAtRef.current > 900;
        if (loopRewound) {
          lastRewindAtRef.current = performance.now();
          const alreadySaved =
            loopCycleSavedRef.current ||
            savedLoopGenRef.current === loopGenRef.current;
          if (
            livePointsRef.current.length > 0 &&
            !finishingRef.current &&
            !alreadySaved
          ) {
            const pts = livePointsRef.current;
            const feet = pts.filter((p) => p.lane).map((p) => p.lane!.feet);
            const span =
              feet.length >= 2 ? Math.max(...feet) - Math.min(...feet) : 0;
            // 短碎軌／中段碎（r6 18–35′）唔存；等完整 foul→pins
            const minL = feet.length ? Math.min(...feet) : 99;
            const maxL = feet.length ? Math.max(...feet) : 0;
            if (
              span >= 35 &&
              minL <= 10 &&
              maxL >= 48 &&
              evaluateShotQuality(pts).ok
            ) {
              finishingRef.current = true;
              finishShot();
            } else {
              livePointsRef.current = [];
              trackerRef.current.beginNewShot({ clearBg: true });
            }
          } else {
            livePointsRef.current = [];
            trackerRef.current.beginNewShot({ clearBg: true });
          }
          // 新圈：世代 +1，允許再存一投；強制清 bg（防第2圈鎖右溝）
          loopGenRef.current += 1;
          loopCycleSavedRef.current = false;
          trackerRef.current.beginNewShot({ clearBg: true });
          lastVideoTimeRef.current = vt;
          lastTrackedVtRef.current = -1;
          gutterRejectStreakRef.current = 0;
          pbaSawHighBoardRef.current = false;
          demoInsetActiveRef.current = true;
          midRecoverUsedRef.current = 0;
          drawOverlay();
          return;
        }
        lastVideoTimeRef.current = vt;

        // upload：同幀唔重跑；bowling-demo 另限 ~15fps（PBA 唔限——60fps 片限 15 會丟 foul／BP）
        if (sourceModeRef.current === "upload") {
          const pbaMode = !!settingsRef.current.boardFromRight;
          const minDt = pbaMode ? 1e-4 : 1 / 15;
          if (
            lastTrackedVtRef.current >= 0 &&
            vt + 1e-6 < lastTrackedVtRef.current + minDt &&
            vt + 1e-4 >= lastTrackedVtRef.current
          ) {
            drawOverlay();
            return;
          }
        }
        lastTrackedVtRef.current = vt;

        // 高解析度縮到 ~640 寬再追（同 offline verify）；座標映射返原圖
        const { scale, tw, th } = trackWorkSize(w, h);
        trackScaleRef.current = scale;
        let trackRgba: Uint8ClampedArray;
        let trackW = w;
        let trackH = h;
        // 追蹤 ROI／pointInLane 用映射梯形（避免 pin skew 拒球）
        // cornersRef.current 已在外層 if 收窄
        let trackCorners = mappingCornersForTrack(cornersRef.current);
        if (scale < 1) {
          let buf = trackBufRef.current;
          if (!buf) {
            buf = document.createElement("canvas");
            trackBufRef.current = buf;
          }
          if (buf.width !== tw || buf.height !== th) {
            buf.width = tw;
            buf.height = th;
          }
          const tctx = buf.getContext("2d", { willReadFrequently: true });
          if (!tctx) {
            drawOverlay();
            return;
          }
          tctx.drawImage(canvas, 0, 0, tw, th);
          const small = tctx.getImageData(0, 0, tw, th);
          trackRgba = small.data;
          trackW = tw;
          trackH = th;
          trackCorners = scaleLaneCorners(trackCorners, scale);
        } else {
          const frame = ctx.getImageData(0, 0, w, h);
          trackRgba = frame.data;
        }
        // bowling-demo upload：inset 避溝；fastRelock 全角；中段鎖穩後切回全角追 pocket
        {
          const pbaMode = !!settingsRef.current.boardFromRight;
          const fast = trackerRef.current.fastRelockFrames > 0;
          if (sourceModeRef.current === "upload" && !pbaMode) {
            const feet = livePointsRef.current
              .filter((p) => p.lane)
              .map((p) => p.lane!.feet);
            // 舊 ≥24′ 太晚：預測未到 24′ 時 inset 一直開 → UI 死喺 ~10–27′
            // 有中段樣本或 max≥16′ 即切全角追 pocket
            if (
              (feet.length >= 3 && Math.max(...feet) >= 16) ||
              (feet.length >= 5 &&
                Math.max(...feet) >= 20 &&
                feet.some((f) => f >= 12 && f <= 30))
            ) {
              demoInsetActiveRef.current = false;
            }
          }
          if (
            sourceModeRef.current === "upload" &&
            !pbaMode &&
            demoInsetActiveRef.current &&
            !fast &&
            trackCorners
          ) {
            trackCorners = insetLaneCorners(trackCorners, 0.15);
          }
        }
        const gray = rgbaToGray(trackRgba, trackW, trackH);
        const result = trackBallFrame(
          trackerRef.current,
          gray,
          trackW,
          trackH,
          settingsRef.current,
          trackCorners,
          dt,
          trackRgba
        );

        if (livePointsRef.current.length % 10 === 0) {
          setDebugNoise(Math.round(result.noiseLevel));
        }

        // 本圈已存或冷卻中：不累積新軌跡，避免多餘短投
        const uploadSavedThisLoop =
          sourceModeRef.current === "upload" &&
          (loopCycleSavedRef.current ||
            savedLoopGenRef.current === loopGenRef.current);
        const blockNewShot =
          uploadSavedThisLoop ||
          performance.now() < shotCooldownUntilRef.current;

        // 僅在已鎖定且有偵測／短預測時寫入軌跡（避免鎖導引線亂線）
        // smoothed 喺工作解析度 → 映返原影像座標做 lane／overlay
        const pos = result.smoothed
          ? scale < 1
            ? {
                x: result.smoothed.x / scale,
                y: result.smoothed.y / scale,
              }
            : result.smoothed
          : null;
        // Corra：homography 用球底 (y+r)，overlay 仍畫圓心
        const radiusFull =
          result.radius != null && result.radius > 0
            ? scale < 1
              ? result.radius / scale
              : result.radius
            : null;
        if (
          !blockNewShot &&
          result.locked &&
          pos &&
          (result.raw != null || result.predicted)
        ) {
          if (livePointsRef.current.length === 0 && !result.predicted) {
            shotStartRef.current = performance.now();
            setStatus("已鎖定球，追蹤中…");
          }
          if (livePointsRef.current.length > 0 || !result.predicted) {
            const t =
              sourceModeRef.current === "upload"
                ? Math.round(vt * 1000)
                : performance.now() - shotStartRef.current;
            const H = homoRef.current;
            let contact = ballContactPoint(pos, radiusFull);
            let lane = H ? imageToLane(H, contact) : undefined;
            // demo densify：fastRelock 預測點喺 12–18′ 時，僅當已近 tony 帶先輕拉
            // （0.28）；遠距硬拉會喺 8–12′ 造 V。唔再硬 snap 14.3。
            {
              const pbaMode = !!settingsRef.current.boardFromRight;
              const fast = trackerRef.current.fastRelockFrames > 0;
              const full = cornersRef.current;
              if (
                !pbaMode &&
                sourceModeRef.current === "upload" &&
                result.predicted &&
                fast &&
                lane &&
                full &&
                H &&
                lane.feet >= 12 &&
                lane.feet <= 18 &&
                lane.board >= 10 &&
                lane.board <= 19
              ) {
                const foulY = (full.bl.y + full.br.y) / 2;
                const pinY = (full.tl.y + full.tr.y) / 2;
                const tt =
                  Math.abs(foulY - pinY) > 1
                    ? Math.max(
                        0,
                        Math.min(1, (foulY - contact.y) / (foulY - pinY))
                      )
                    : 0.25;
                const leftX = full.bl.x + (full.tl.x - full.bl.x) * tt;
                const rightX = full.br.x + (full.tr.x - full.br.x) * tt;
                const targetX = leftX + (rightX - leftX) * (14.3 / 39);
                const tx = contact.x * 0.72 + targetX * 0.28;
                contact = { x: tx, y: contact.y };
                lane = imageToLane(H, contact) ?? lane;
              }
            }
            // 過濾明顯不合理的瞬間跳點（lane 空間）
            const prev = livePointsRef.current[livePointsRef.current.length - 1];
            let accept = true;
            if (lane) {
              const seeded = trackerRef.current.seed != null;
              const pbaMode = !!settingsRef.current.boardFromRight;
              if (sourceModeRef.current === "upload" && !seeded && pbaMode) {
                // PBA：同 offline soft edge（拒爬溝／15fps 會令覆蓋只剩 19–22′）
                if (
                  (lane.board < 0.3 || lane.board > 38.7) &&
                  lane.feet < 50
                ) {
                  accept = false;
                }
                // 早期／中段假鎖：左規 mid 14–23.5 喺 <25′（真球箭頭區左規 ≳24）
                // 舊 <20′/10–22.5 唔夠——UI 會喺 ≥20′ 鎖 mid L~19 → 翻轉 Arr 19.9 / BP—
                if (
                  lane.feet < 25 &&
                  lane.board > 14 &&
                  lane.board < 23.5
                ) {
                  accept = false;
                }
                // 真球左規 ≳24；若從未見過且喺 ≥25′ 持續 mid 15–23.5 → 解鎖重追
                if (accept) {
                  if (lane.board >= 24) {
                    pbaSawHighBoardRef.current = true;
                    gutterRejectStreakRef.current = 0;
                  } else if (
                    !pbaSawHighBoardRef.current &&
                    lane.feet >= 25 &&
                    lane.board > 15 &&
                    lane.board < 23.5
                  ) {
                    gutterRejectStreakRef.current += 1;
                    if (gutterRejectStreakRef.current >= 10) {
                      accept = false;
                      livePointsRef.current = [];
                      setLivePath([]);
                      setLiveEstimate(null);
                      trackerRef.current.beginNewShot({ clearBg: true });
                      gutterRejectStreakRef.current = 0;
                      pbaSawHighBoardRef.current = false;
                    }
                  }
                }
              } else if (sourceModeRef.current === "upload" && !pbaMode) {
                // bowling-demo（含點球鎖定）：極端溝仍拒；手動四角真球可從左規 board~5–7 出發
                // 舊只 !seeded → TesterManual 點球後跳過 softRelock／nudge，中段易死
                if (lane.feet < 52 && (lane.board >= 30 || lane.board <= 2.8)) {
                  accept = false;
                }
                if (lane.feet < 16 && lane.board >= 22) {
                  accept = false;
                }
                // 中後段右漂入溝（seeded 假軌 board→31）
                if (lane.feet >= 16 && lane.feet < 55 && lane.board >= 27) {
                  accept = false;
                }
                // 早期左溝假鎖 → softRelock；中段靠左 board5–8 可能係真球，只 nudge
                // softRelock 只喺未建立中段前用（避免抹掉 foul→中段）
                const leftGutterish =
                  lane.feet < 16 && lane.board <= 5.5;
                const rightCrawl =
                  lane.feet < 24 && lane.board >= 30;
                const midLeftDrift =
                  lane.feet >= 16 &&
                  lane.feet < 45 &&
                  lane.board <= 5.0;
                const lanePts = livePointsRef.current.filter((p) => p.lane);
                const maxLive = lanePts.reduce(
                  (m, p) => Math.max(m, p.lane!.feet),
                  0
                );
                const established =
                  maxLive >= 18 &&
                  lanePts.some(
                    (p) =>
                      p.lane!.feet >= 10 &&
                      p.lane!.board > 8 &&
                      p.lane!.board < 22
                  );
                const stuckLow =
                  !established &&
                  lane.feet < 12 &&
                  lane.board <= 8 &&
                  lanePts.length >= 4 &&
                  lanePts.every((p) => p.lane!.feet < 12);
                if (leftGutterish || rightCrawl) {
                  accept = false;
                }
                // 中段左漂：拒極端 ≤3.5 溝點，5.0 以下仍 nudge 但 ≥3.5 可入軌
                if (midLeftDrift && lane.board <= 3.5) {
                  accept = false;
                }
                if (
                  !established &&
                  (leftGutterish || rightCrawl || stuckLow)
                ) {
                  gutterRejectStreakRef.current += 1;
                  const need = stuckLow || leftGutterish ? 1 : 2;
                  if (gutterRejectStreakRef.current >= need) {
                    const sc = trackScaleRef.current;
                    const full = cornersRef.current;
                    if (full) {
                      const work =
                        sc < 1 ? scaleLaneCorners(full, sc) : full;
                      trackerRef.current.softRelockMid(work);
                      livePointsRef.current = livePointsRef.current.filter(
                        (p) => !p.lane || p.lane.feet <= 14
                      );
                    } else {
                      trackerRef.current.beginNewShot({ clearBg: true });
                    }
                    gutterRejectStreakRef.current = 0;
                  }
                } else if (established && (midLeftDrift || rightCrawl)) {
                  const sc = trackScaleRef.current;
                  const full = cornersRef.current;
                  if (full) {
                    trackerRef.current.nudgeMidKeepLock(
                      sc < 1 ? scaleLaneCorners(full, sc) : full
                    );
                  }
                  gutterRejectStreakRef.current = 0;
                } else if (lane.board > 6 && lane.board < 28) {
                  gutterRejectStreakRef.current = 0;
                }
              } else {
                const edgeBoard = seeded ? 0.15 : 1.2;
                if (
                  (lane.board < edgeBoard || lane.board > 39 - edgeBoard) &&
                  lane.feet < 48
                ) {
                  accept = false;
                }
              }
            }
            if (accept && prev?.lane && lane) {
              const dFeet = lane.feet - prev.lane.feet;
              const dBoard = Math.abs(lane.board - prev.lane.board);
              const dtPt = Math.max(1, t - prev.t) / 1000;
              const pbaMode = !!settingsRef.current.boardFromRight;
              if (pbaMode) {
                // PBA：同 offlineSoft 容許變焦回退
                if (dFeet < -8.0) accept = false;
                if (dBoard > 28) accept = false;
              } else {
                const fast =
                  sourceModeRef.current === "upload" &&
                  trackerRef.current.fastRelockFrames > 0;
                // softRelock 海岸：容許短暫 feet 回／橫跳；否則 apex 段全被 jump 拒
                const backLim = fast ? -3.5 : -0.8;
                const boardJumpLim = fast ? 6.5 : 3.5;
                if (dFeet < backLim || (dBoard > boardJumpLim && dFeet < 1.0))
                  accept = false;
                // 中後段補點常一次跳 8–12′；90 ft/s 太緊 → 覆蓋死喺 ~40′
                const speedCap =
                  sourceModeRef.current === "upload" && lane.feet >= 20
                    ? 150
                    : 90;
                if (Math.abs(dFeet) / dtPt > speedCap || dBoard > 14)
                  accept = false;
                // climb：只擋急衝右溝；pocket hook board 22–28 要放行
                if (
                  sourceModeRef.current === "upload" &&
                  lane.board > 28 &&
                  dFeet > 0.35 &&
                  dBoard / dFeet > 1.8
                ) {
                  accept = false;
                }
                // 拒尖角：fastRelock 期間放行（否則海岸重鎖被誤殺、覆蓋死早段）
                // 非 fast：早段預測仍擋極端 V；中段擋折角。最終靠 smoothDemoPath 清殘峰。
                if (
                  accept &&
                  sourceModeRef.current === "upload" &&
                  !pbaMode &&
                  !fast &&
                  livePointsRef.current.length >= 2 &&
                  dFeet > 0.2
                ) {
                  const p2 =
                    livePointsRef.current[livePointsRef.current.length - 2];
                  if (p2?.lane) {
                    const dB1 = prev.lane.board - p2.lane.board;
                    const dF1 = Math.max(
                      0.15,
                      prev.lane.feet - p2.lane.feet
                    );
                    const slope1 = dB1 / dF1;
                    const slope2 =
                      (lane.board - prev.lane.board) / dFeet;
                    const turn = Math.abs(slope2 - slope1);
                    const early = prev.lane.feet < 18;
                    const pred = !!result.predicted;
                    if (early && pred && turn > 2.4) accept = false;
                    else if (early && turn > 3.2) accept = false;
                    else if (!early && turn > 2.2) accept = false;
                    else if (turn > 3.5) accept = false;
                  }
                }
              }
            }
            if (accept) {
              // 疏點補插：14–16′ 大跳 + 8–22′ 任意 >2.8′ 空隙（防 13–15′ elbow）
              if (prev?.lane && lane && !result.predicted) {
                const dF = lane.feet - prev.lane.feet;
                const inTonySpan =
                  prev.lane.feet < 22 &&
                  lane.feet > 8 &&
                  prev.lane.board > 8 &&
                  prev.lane.board < 23 &&
                  lane.board > 8 &&
                  lane.board < 23;
                const crossArrows =
                  dF > 3.5 &&
                  prev.lane.feet < 15.5 &&
                  lane.feet > 14.5 &&
                  prev.lane.board > 9 &&
                  prev.lane.board < 22 &&
                  lane.board > 9 &&
                  lane.board < 22;
                const sparseTony = inTonySpan && dF > 2.8;
                if (crossArrows || sparseTony) {
                  const targets: number[] = [];
                  if (crossArrows) {
                    for (const tf of [13, 14, 15, 16]) targets.push(tf);
                  } else {
                    // 每隔 ~1.4′ 插一點
                    const n = Math.min(4, Math.max(1, Math.floor(dF / 1.4)));
                    for (let k = 1; k <= n; k++) {
                      targets.push(prev.lane.feet + (dF * k) / (n + 1));
                    }
                  }
                  for (const tf of targets) {
                    if (tf <= prev.lane.feet + 0.35 || tf >= lane.feet - 0.35)
                      continue;
                    const u = (tf - prev.lane.feet) / dF;
                    // 直線插值（唔硬吸 14.3——避免假 Arr）；最終靠 smoothDemoPath densify
                    const b =
                      prev.lane.board + u * (lane.board - prev.lane.board);
                    if (b < 7.5 || b > 24) continue;
                    livePointsRef.current.push({
                      image: {
                        x: prev.image.x + u * (contact.x - prev.image.x),
                        y: prev.image.y + u * (contact.y - prev.image.y),
                      },
                      lane: { feet: tf, board: b },
                      t: prev.t + u * (t - prev.t),
                      predicted: true,
                    });
                  }
                }
              }
              const tp: TrackPoint = {
                image: contact,
                lane,
                t,
                predicted: result.predicted || undefined,
              };
              livePointsRef.current.push(tp);
              if (livePointsRef.current.length % 3 === 0) {
                const pbaLive = !!settingsRef.current.boardFromRight;
                const forUi =
                  sourceModeRef.current === "upload" && !pbaLive
                    ? smoothDemoPath(livePointsRef.current)
                    : livePointsRef.current;
                const path = forUi
                  .filter((p) => p.lane)
                  .map((p) => p.lane!);
                setLivePath(path);
                const rpm = getRpmEstimate(trackerRef.current);
                setLiveEstimate(
                  computeShotEstimate(forUi, rpm, {
                    boardFromRight: settingsRef.current.boardFromRight,
                  })
                );
              }
            }
          }
        }

        const canSaveShot =
          !finishingRef.current &&
          !uploadSavedThisLoop &&
          performance.now() >= shotCooldownUntilRef.current;

        {
          const pbaMode = !!settingsRef.current.boardFromRight;
          const liveFeet = livePointsRef.current
            .filter((p) => p.lane)
            .map((p) => p.lane!.feet);
          const maxLiveFeet =
            liveFeet.length > 0 ? Math.max(...liveFeet) : 0;
          // bowling-demo：中段 lost 高但未到袋口 → 前進 softRelock（最多兩次）
          // r6：一次 recover 後仍可喺 ~35′ 死；第二次幫捱到 pins
          if (
            sourceModeRef.current === "upload" &&
            !pbaMode &&
            midRecoverUsedRef.current < 2 &&
            trackerRef.current.locked &&
            trackerRef.current.lost >= (midRecoverUsedRef.current === 0 ? 10 : 12) &&
            maxLiveFeet >= 14 &&
            maxLiveFeet < 48 &&
            trackerRef.current.fastRelockFrames <= 0
          ) {
            const sc = trackScaleRef.current;
            const full = cornersRef.current;
            if (full) {
              const work = sc < 1 ? scaleLaneCorners(full, sc) : full;
              trackerRef.current.softRelockMid(work);
              livePointsRef.current = livePointsRef.current.filter(
                (p) => !p.lane || p.lane.feet <= maxLiveFeet + 2
              );
              demoInsetActiveRef.current = false;
              midRecoverUsedRef.current += 1;
            }
          }
          // PBA：要捱過變焦先收；未到 ~38′ 用更高 lost 門檻
          const endSettings = pbaMode
            ? {
                ...settingsRef.current,
                lostFramesToEnd: maxLiveFeet >= 38 ? 48 : 72,
              }
            : sourceModeRef.current === "upload"
              ? {
                  ...settingsRef.current,
                  // bowling-demo：中後段多捱；抬高避免 UI 預測衰減後 ~27′ 早收
                  lostFramesToEnd:
                    maxLiveFeet >= 40
                      ? 56
                      : maxLiveFeet >= 28
                        ? 50
                      : maxLiveFeet >= 16
                          ? 40
                          : Math.max(settingsRef.current.lostFramesToEnd, 28),
                }
              : settingsRef.current;
          if (
            canSaveShot &&
            shouldEndShot(
              trackerRef.current,
              endSettings,
              livePointsRef.current.length > 0
            )
          ) {
            let allowFinish = true;
            if (pbaMode && livePointsRef.current.length > 0) {
              const peek = computeShotEstimate(livePointsRef.current, null, {
                boardFromRight: true,
              });
              const arr = peek.arrowsBoard;
              const arrOk = arr != null && arr >= 6 && arr <= 17.5;
              // Arr 未入帶：唔收——重置 lost 再捱（真球可能仲未鎖穩）
              if (!arrOk) {
                allowFinish = false;
                trackerRef.current.lost = 0;
                // 覆蓋已深但仍 mid-dump：丟軌重鎖，避免無限捱同一條假軌
                const maxF = peek.coverageFeetMax ?? 0;
                if (maxF >= 36) {
                  livePointsRef.current = [];
                  setLivePath([]);
                  setLiveEstimate(null);
                  trackerRef.current.beginNewShot({ clearBg: true });
                }
              }
            } else if (
              !pbaMode &&
              sourceModeRef.current === "upload" &&
              livePointsRef.current.length > 0
            ) {
              // bowling-demo：未 foul→pins 唔收——丟短碎等下一圈／再點球
              const rawF = livePointsRef.current
                .filter((pt) => pt.lane && !pt.predicted)
                .map((pt) => pt.lane!.feet);
              if (rawF.length >= 2) {
                const minF = Math.min(...rawF);
                const maxF = Math.max(...rawF);
                if (minF > 10 || maxF < 48) {
                  allowFinish = false;
                  livePointsRef.current = [];
                  setLivePath([]);
                  setLiveEstimate(null);
                  setStatus(
                    `覆蓋不足（${minF.toFixed(0)}–${maxF.toFixed(0)}′），繼續追蹤…`
                  );
                  midRecoverUsedRef.current = 0;
                  demoInsetActiveRef.current = true;
                  trackerRef.current.beginNewShot({ clearBg: true });
                }
              }
            }
            if (allowFinish) {
              finishingRef.current = true;
              finishShot();
            }
          } else if (
            !result.locked &&
            livePointsRef.current.length > 0 &&
            !finishingRef.current
          ) {
            const pts = livePointsRef.current;
            if (sourceModeRef.current === "upload") {
              // 溝拒解鎖後一律保留軌跡；只有完全冇 lane 點先丟
              const nLane = pts.filter((p) => p.lane).length;
              if (nLane < 1) {
                livePointsRef.current = [];
                setLivePath([]);
                trackerRef.current.beginNewShot({ clearBg: true });
              }
            } else if (canSaveShot && evaluateShotQuality(pts).ok) {
              finishingRef.current = true;
              finishShot();
            } else {
              livePointsRef.current = [];
              setLivePath([]);
              trackerRef.current.beginNewShot();
            }
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
      const s = trackScaleRef.current || 1;
      trackerRef.current.seedAt({ x: p.x * s, y: p.y * s });
      midRecoverUsedRef.current = 0;
      demoInsetActiveRef.current = true;
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
    lastDebugShotRef.current = null;
    if (typeof window !== "undefined") {
      (window as unknown as { __bowlLastShot?: unknown }).__bowlLastShot = null;
    }
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
    trackScaleRef.current = 1;
    lastFrameTRef.current = 0;
    setLivePath([]);
    setLiveEstimate(null);
    setPhase("track");
    setTracking(true);
    lastVideoTimeRef.current = 0;
    lastTrackedVtRef.current = -1;
    gutterRejectStreakRef.current = 0;
    pbaSawHighBoardRef.current = false;
    demoInsetActiveRef.current = true;
    midRecoverUsedRef.current = 0;
    finishingRef.current = false;
    shotCooldownUntilRef.current = 0;
    loopCycleSavedRef.current = false;
    stopFlushDoneRef.current = false;
    loopGenRef.current = 0;
    savedLoopGenRef.current = -1;
    lastSavedShotRef.current = null;
    lastRewindAtRef.current = 0;
    setStatus(
      "等待紫色／暗色球出現…也可直接點球鎖定；消失或影片重播會自動存檔（每圈最多一投）"
    );
  };

  const stopTracking = () => {
    if (!stopFlushDoneRef.current) {
      stopFlushDoneRef.current = true;
      if (
        livePointsRef.current.length >= 10 &&
        !finishingRef.current &&
        !(
          sourceModeRef.current === "upload" &&
          (loopCycleSavedRef.current ||
            savedLoopGenRef.current === loopGenRef.current)
        )
      ) {
        finishingRef.current = true;
        finishShot();
      } else {
        livePointsRef.current = [];
        setLivePath([]);
        trackerRef.current.beginNewShot();
        finishingRef.current = false;
      }
    }
    setTracking(false);
    setPhase("calibrate");
    setStatus("已停止追蹤");
  };


  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      __bowlDebug?: {
        setCorners: (c: LaneCorners) => void;
        setPba: (v: boolean) => void;
        start: () => void;
        stop: () => void;
        getLast: () => unknown;
        getStatus: () => string;
      };
    };
    w.__bowlDebug = {
      setCorners: (c) => persistCorners(c),
      setPba: (v) =>
        setSettings((s) => ({
          ...s,
          boardFromRight: v,
        })),
      start: () => startTracking(),
      stop: () => stopTracking(),
      getLast: () => lastDebugShotRef.current,
      getStatus: () => status,
    };
    return () => {
      delete w.__bowlDebug;
    };
  });

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
    if (
      !confirm(
        "建立新球局？目前鏡頭／影片與投球紀錄會離開本局（舊局仍留在本機）。"
      )
    ) {
      return;
    }
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
          title={
            detecting
              ? "正在偵測球道…"
              : tracking
                ? "追蹤中無法偵測，請先停止追蹤"
                : !videoReady
                  ? "請先開啟鏡頭或上傳影片"
                  : "自動估測球道四角"
          }
          className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {detecting ? "偵測中…" : "自動偵測球道"}
        </button>
        {!tracking ? (
          <button
            type="button"
            onClick={startTracking}
            disabled={!videoReady || !corners}
            title={
              !videoReady
                ? "請先開啟鏡頭或上傳影片"
                : !corners
                  ? "請先自動偵測或拖曳四角標定球道"
                  : "開始追蹤球路"
            }
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
          disabled={!session || session.shots.length === 0}
          title={
            !session || session.shots.length === 0
              ? "本局尚無投球紀錄可清除"
              : "清除本局所有投球紀錄"
          }
          className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
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
                開啟鏡頭或上傳影片
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
            <label className="mt-2 flex items-center gap-2 text-sm text-amber-200/90">
              <input
                type="checkbox"
                checked={!!settings.boardFromRight}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    boardFromRight: e.target.checked,
                  }))
                }
                className="accent-amber-500"
              />
              PBA board（右溝=0，39−x）— 手動四角追 PBA 片請勾
            </label>

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
                區後消失、或影片 loop 回繞時會結束並存檔（每圈最多一投；冷卻避免短投連存）。指標只依實際軌跡覆蓋；不足顯示 — 或標外推。
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
