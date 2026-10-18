/**
 * Bowl Track 指標準確度評分（對齊 test-media/eval/ACCURACY-EVAL.md）
 *
 * 用法：
 *   npx tsx scripts/score-accuracy.mts --gt test-media/eval/ground-truth.json --pred test-media/eval/pred-example.json
 *   npm run score:accuracy -- --gt ... --pred ... [--include-estimates] [--out ...]
 *
 * 只對 gtStatus==="confirmed" 計正式分；加 --include-estimates 可試跑 estimate_unconfirmed。
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

type MetricVal = { value: number | null; unit?: string; notes?: string };
type GtShot = {
  shotId: string;
  gtStatus: "confirmed" | "estimate_unconfirmed" | "todo";
  metrics: Record<string, MetricVal | undefined>;
};
type GtVideo = { videoId: string; file?: string; shots: GtShot[] };
type GtFile = {
  schemaVersion: number;
  tolerances: Record<string, number>;
  priorityMetrics?: string[];
  secondaryMetrics?: string[];
  lastMetrics?: string[];
  videos: GtVideo[];
};

/** pred：ShotEstimate 扁平欄，或 { shots: [{ shotId, estimate|metrics }] } / session */
type PredShot = {
  shotId?: string;
  videoId?: string;
  estimate?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  [k: string]: unknown;
};

const DEFAULT_TOL: Record<string, number> = {
  arrowsBoard: 2,
  breakpointBoard: 2,
  pocketBoard: 2,
  foulBoard: 2,
  avgSpeedMph: 3,
  launchSpeedMph: 3,
  impactSpeedMph: 3,
  launchAngleDeg: 3,
  impactAngleDeg: 3,
  rpm: 100,
  shotTimeSec: 0.5,
  breakpointDistanceFt: 3,
};

/** GT metric key → pred ShotEstimate 欄位 */
const PRED_ALIASES: Record<string, string[]> = {
  avgSpeedMph: ["avgSpeedMph", "speedMph"],
  launchSpeedMph: ["launchSpeedMph"],
  impactSpeedMph: ["impactSpeedMph"],
  arrowsBoard: ["arrowsBoard", "entryBoard"],
  breakpointBoard: ["breakpointBoard"],
  breakpointDistanceFt: ["breakpointDistanceFt", "breakpointDistance"],
  pocketBoard: ["pocketBoard"],
  foulBoard: ["foulBoard"],
  shotTimeSec: ["shotTimeSec"],
  launchAngleDeg: ["launchAngleDeg"],
  impactAngleDeg: ["impactAngleDeg"],
  rpm: ["rpm"],
};

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--include-estimates") out.includeEstimates = true;
    else if (a === "--gt" || a === "--pred" || a === "--out" || a === "--video" || a === "--shot") {
      out[a.slice(2)] = argv[++i] ?? "";
    } else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function isMissing(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "number" && Number.isNaN(v)) return true;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || s === "—" || s === "-" || s.toLowerCase() === "null") return true;
  }
  return false;
}

function asNumber(v: unknown): number | null {
  if (isMissing(v)) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v != null && "value" in v) {
    return asNumber((v as { value: unknown }).value);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scoreMetric(pred: number | null, gt: number | null, tol: number): {
  score: number | null;
  skipped: boolean;
  reason?: string;
} {
  if (gt == null && pred == null) return { score: null, skipped: true, reason: "both_missing" };
  if (gt == null) return { score: null, skipped: true, reason: "gt_missing" };
  if (pred == null) return { score: 0, skipped: false, reason: "missing_pred" };
  if (!(tol > 0)) return { score: null, skipped: true, reason: "bad_tol" };
  const s = Math.max(0, 100 * (1 - Math.abs(pred - gt) / tol));
  return { score: Math.round(s * 10) / 10, skipped: false };
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function flattenPredShots(raw: unknown): PredShot[] {
  if (Array.isArray(raw)) return raw as PredShot[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // 整份 GT 風格 / session
    if (Array.isArray(o.shots)) return o.shots as PredShot[];
    if (Array.isArray(o.videos)) {
      const shots: PredShot[] = [];
      for (const v of o.videos as { videoId?: string; shots?: PredShot[] }[]) {
        for (const s of v.shots ?? []) {
          shots.push({ ...s, videoId: s.videoId ?? v.videoId });
        }
      }
      return shots;
    }
    // 單個 estimate
    if (o.estimate || o.avgSpeedMph != null || o.metrics) return [o as PredShot];
    // siteReferenceOnly 包一層
    if (o.siteReferenceOnly && typeof o.siteReferenceOnly === "object") {
      return [{ shotId: String(o.shotId ?? "pred-1"), estimate: o.siteReferenceOnly as Record<string, unknown> }];
    }
  }
  throw new Error("pred JSON 無法解析：需要 estimate、shots[]、或 session/videos 結構");
}

function predValue(shot: PredShot, metricKey: string): number | null {
  const bag: Record<string, unknown> = {
    ...(typeof shot.estimate === "object" && shot.estimate ? shot.estimate : {}),
    ...(typeof shot.metrics === "object" && shot.metrics ? shot.metrics : {}),
    ...shot,
  };
  // metrics 可能是 { value } 結構
  const aliases = PRED_ALIASES[metricKey] ?? [metricKey];
  for (const k of aliases) {
    const v = bag[k];
    const n = asNumber(v);
    if (n != null) return n;
  }
  return null;
}

function metricKeys(gt: GtFile): string[] {
  const fromShots = new Set<string>();
  for (const v of gt.videos) {
    for (const s of v.shots) {
      for (const k of Object.keys(s.metrics ?? {})) fromShots.add(k);
    }
  }
  const ordered = [
    ...(gt.priorityMetrics ?? []),
    ...(gt.secondaryMetrics ?? []),
    ...(gt.lastMetrics ?? []),
  ];
  const rest = [...fromShots].filter((k) => !ordered.includes(k));
  const all = [...ordered, ...rest].filter((k) => fromShots.has(k) || DEFAULT_TOL[k] != null);
  return all.length ? all : Object.keys(gt.tolerances ?? DEFAULT_TOL);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.gt || !args.pred) {
    console.log(`Usage: npx tsx scripts/score-accuracy.mts --gt <gt.json> --pred <pred.json> [options]
  --include-estimates   連 estimate_unconfirmed 一齊計（標 unofficial）
  --out <path>          寫報告 JSON（預設 test-media/eval/last-score-report.json）
  --video <videoId>     只評此片
  --shot <shotId>       只評此投`);
    process.exit(args.help ? 0 : 1);
  }

  const gtPath = resolve(String(args.gt));
  const predPath = resolve(String(args.pred));
  const outPath = resolve(
    String(args.out ?? "test-media/eval/last-score-report.json")
  );
  const includeEstimates = !!args.includeEstimates;

  const gt = loadJson(gtPath) as GtFile;
  const predShots = flattenPredShots(loadJson(predPath));
  const tolerances = { ...DEFAULT_TOL, ...(gt.tolerances ?? {}) };
  const keys = metricKeys(gt);

  type Row = {
    videoId: string;
    shotId: string;
    gtStatus: string;
    official: boolean;
    metric: string;
    gt: number | null;
    pred: number | null;
    tol: number;
    score: number | null;
    skipped: boolean;
    reason?: string;
  };
  const rows: Row[] = [];

  for (const video of gt.videos) {
    if (args.video && video.videoId !== args.video) continue;
    for (const shot of video.shots) {
      if (args.shot && shot.shotId !== args.shot) continue;
      const official = shot.gtStatus === "confirmed";
      if (!official && !includeEstimates) continue;
      if (shot.gtStatus === "todo" && !includeEstimates) continue;

      // 配 pred：shotId 優先，否則同 video 第一條／唯一
      let pred =
        predShots.find((p) => p.shotId === shot.shotId) ??
        predShots.find((p) => p.videoId === video.videoId) ??
        (predShots.length === 1 ? predShots[0] : undefined);

      for (const metric of keys) {
        const gtM = shot.metrics?.[metric];
        const gtVal = gtM ? asNumber(gtM.value) : null;
        const predVal = pred ? predValue(pred, metric) : null;
        const tol = tolerances[metric] ?? DEFAULT_TOL[metric] ?? 1;
        const { score, skipped, reason } = scoreMetric(predVal, gtVal, tol);
        rows.push({
          videoId: video.videoId,
          shotId: shot.shotId,
          gtStatus: shot.gtStatus,
          official,
          metric,
          gt: gtVal,
          pred: predVal,
          tol,
          score,
          skipped,
          reason,
        });
        const tag = official ? "official" : "UNOFFICIAL";
        const scoreStr = skipped ? "skip" : String(score);
        console.log(
          `[${tag}] videoId=${video.videoId} shot=${shot.shotId} metric=${metric} gt=${gtVal ?? "null"} pred=${predVal ?? "null"} tol=${tol} score=${scoreStr}${reason ? ` (${reason})` : ""}`
        );
      }
    }
  }

  if (rows.length === 0) {
    console.error(
      "無計分行。若 GT 全係 estimate_unconfirmed，請加 --include-estimates 試跑。"
    );
    process.exit(2);
  }

  const scored = rows.filter((r) => !r.skipped && r.score != null);
  const officialScored = scored.filter((r) => r.official);
  const byMetric: Record<string, { n: number; avg: number; scores: number[] }> = {};
  for (const r of scored) {
    if (!byMetric[r.metric]) byMetric[r.metric] = { n: 0, avg: 0, scores: [] };
    byMetric[r.metric].scores.push(r.score!);
  }
  for (const k of Object.keys(byMetric)) {
    const s = byMetric[k].scores;
    byMetric[k].n = s.length;
    byMetric[k].avg = Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10;
  }

  const overallAvg =
    scored.length === 0
      ? null
      : Math.round((scored.reduce((a, r) => a + r.score!, 0) / scored.length) * 10) / 10;
  const officialAvg =
    officialScored.length === 0
      ? null
      : Math.round(
          (officialScored.reduce((a, r) => a + r.score!, 0) / officialScored.length) * 10
        ) / 10;

  const worst = [...scored].sort((a, b) => a.score! - b.score!).slice(0, 3);

  console.log("\n--- 分項平均 ---");
  for (const k of keys) {
    if (byMetric[k]) console.log(`  ${k}: ${byMetric[k].avg}% (n=${byMetric[k].n})`);
  }
  console.log(
    `\n全體平均（計入項）: ${overallAvg ?? "—"}%  |  正式 confirmed 平均: ${officialAvg ?? "—"}%`
  );
  if (!includeEstimates && officialScored.length === 0) {
    console.log("（本次無 confirmed；結果非正式準確度）");
  }
  if (includeEstimates) {
    console.log("※ --include-estimates：含 estimate_unconfirmed，報告標 UNOFFICIAL");
  }
  if (worst.length) {
    console.log("最差 3 項:");
    for (const w of worst) {
      console.log(`  ${w.metric} shot=${w.shotId} score=${w.score}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    gtPath,
    predPath,
    includeEstimates,
    unofficial: includeEstimates || officialAvg == null,
    overallAvg,
    officialAvg,
    byMetric,
    worst: worst.map((w) => ({
      metric: w.metric,
      shotId: w.shotId,
      score: w.score,
      gt: w.gt,
      pred: w.pred,
    })),
    rows,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
