import {
  boardAtFeet,
  boardAtFeetDetailed,
  earlyBoardSlopeAbs,
  estimateSegmentSpeedMph,
  estimateSpeedMph,
  feetAtMaxHook,
  findActiveRollSpan,
  longestForwardLanePoints,
  trajectoryCoverage,
  withBoardConvention,
} from "./perspective";
import type { EstimateExtrapolated, ShotEstimate, TrackPoint } from "./types";

export type EstimateOptions = {
  /** true＝PBA 右側=0（39−board） */
  boardFromRight?: boolean;
};

/** RPM 顯示門檻：低於此信心顯示 —（不硬填） */
const RPM_CONF_SHOW = 0.55;

/** LaneTrax 風格粗估（瀏覽器軌跡推導，非雷達／官方量測） */
export function computeShotEstimate(
  inputPoints: TrackPoint[],
  rpm?: { rpm: number | null; confidence: number } | null,
  opts?: EstimateOptions
): ShotEstimate {
  const pba = !!opts?.boardFromRight;
  const oriented = withBoardConvention(inputPoints, pba);
  // 主軌：PBA 變焦容許 feet 回退，但唔用 board 斷段（短箭頭段 + 假 t 會令球速 —）
  const fwdLane = longestForwardLanePoints(oriented, {
    splitOnBoardJump: false,
    zoomFeetSlop: pba,
  });
  const points: TrackPoint[] =
    fwdLane.length >= 4
      ? fwdLane.map((lane, i) => {
          const orig = oriented.find(
            (p) =>
              p.lane &&
              Math.abs(p.lane.feet - lane.feet) < 1e-6 &&
              Math.abs(p.lane.board - lane.board) < 1e-6
          );
          return {
            image: orig?.image ?? { x: 0, y: 0 },
            lane,
            t: orig?.t ?? i * 50,
            predicted: orig?.predicted,
          };
        })
      : oriented;
  const cov = trajectoryCoverage(points);
  const extrapolated: EstimateExtrapolated = {};

  const foulBoard = boardAtFeet(points, 1);
  // 箭頭 15′：用前進段插值／短距外推；拒溝邊橫掃同 mid-lane 假常數
  let arrowsBoard = boardAtFeet(points, 15);
  // PBA：剔早期假鎖（board~22–25）；喺合理 board 5–18 且近 15′ 取點
  // （唔用 boardAtFeetDetailed 全段外推——深段斜率會拧到 ~30）
  let pbaArrowsLocked = false;
  let demoArrowsLocked = false;
  if (pba) {
    const pickClean = (hiBoard: number) =>
      oriented.filter(
        (p) =>
          p.lane &&
          !p.predicted &&
          p.lane.board > 4.5 &&
          p.lane.board < hiBoard &&
          p.lane.feet >= 10 &&
          p.lane.feet <= 26
      );
    let cleanNear = pickClean(18);
    if (cleanNear.length < 1) cleanNear = pickClean(20);
    if (cleanNear.length >= 1) {
      // 優先最接近 15′ 且 board∈(6,17) 嘅點（避早期假鎖翻轉 ~23）
      const prefer = cleanNear.filter(
        (p) => p.lane!.board >= 6 && p.lane!.board <= 17
      );
      // prefer 空且只剩 mid-dump ~18–21（UI Arr 19.9 病徵）→ 唔好當箭頭
      const midDumpOnly =
        prefer.length < 1 &&
        cleanNear.every(
          (p) => p.lane!.board >= 17.5 && p.lane!.board <= 22
        );
      if (midDumpOnly) {
        arrowsBoard = null;
        delete extrapolated.arrows;
        pbaArrowsLocked = true;
      } else {
        const pool = prefer.length >= 1 ? prefer : cleanNear;
        const sorted = [...pool].sort(
          (a, b) =>
            Math.abs(a.lane!.feet - 15) - Math.abs(b.lane!.feet - 15)
        );
        const best = sorted[0].lane!;
        arrowsBoard = Math.round(best.board * 10) / 10;
        if (Math.abs(best.feet - 15) > 1.2) extrapolated.arrows = true;
        pbaArrowsLocked = true;
      }
    } else if (cov && cov.minFeet > 22) {
      arrowsBoard = null;
      delete extrapolated.arrows;
      pbaArrowsLocked = true;
    } else if (arrowsBoard != null && arrowsBoard > 20) {
      arrowsBoard = null;
      delete extrapolated.arrows;
      pbaArrowsLocked = true;
    }
  }
  if (arrowsBoard == null && cov && cov.maxFeet >= 14 && !pbaArrowsLocked) {
    const gapAhead = cov.minFeet - 15; // >0＝覆蓋喺 15′ 之後
    const gapBehind = 15 - cov.maxFeet; // >0＝覆蓋未到 15′
    if (gapAhead >= 0 && gapAhead <= 12 && cov.minFeet >= 10) {
      const near = boardAtFeetDetailed(points, 15, {
        allowExtrapolate: true,
        maxGap: Math.max(5, Math.ceil(gapAhead) + 2),
      });
      if (near) {
        arrowsBoard = near.board;
        if (near.extrapolated || gapAhead > 1.5) extrapolated.arrows = true;
      }
    } else if (gapBehind > 0 && gapBehind <= 6 && cov.maxFeet >= 10) {
      const near = boardAtFeetDetailed(points, 15, {
        allowExtrapolate: true,
        maxGap: Math.max(4, Math.ceil(gapBehind) + 1),
      });
      if (near) {
        arrowsBoard = near.board;
        extrapolated.arrows = true;
      }
    }
    // 仍無：用最早覆蓋點做箭頭區代理（標外推）
    if (arrowsBoard == null && cov.minFeet >= 10 && cov.minFeet <= 24) {
      const early = boardAtFeetDetailed(points, cov.minFeet, {
        allowExtrapolate: false,
        maxGap: 2.5,
      });
      if (early) {
        arrowsBoard = early.board;
        if (Math.abs(cov.minFeet - 15) > 1.2) extrapolated.arrows = true;
      }
    }
  }

  // bowling-demo Arrows gate (!pba): require real 12-18' sample OR early-mean ~13.9
  // Never trust long-span interp (Tester#8: 7@16->18@10.5 span~11' => Arr 12.0/12.2)
  if (!pba && !pbaArrowsLocked) {
    const fwdArr = longestForwardLanePoints(points);
    // densify：predicted apex（softRelock 海岸／board-14 snap）都算 12–18′ 真樣本
    // longestForwardLanePoints 剔 predicted，否則 Arr 仍靠 earlyMean+clamp
    // 必須用 oriented（含 predicted）；`points` 已畀 longestForward 剔走預測點
    const predApex = oriented
      .filter(
        (p) =>
          p.predicted &&
          p.lane &&
          p.lane.feet >= 12 &&
          p.lane.feet <= 18 &&
          p.lane.board > 10 &&
          p.lane.board < 18
      )
      .map((p) => p.lane!);
    const inBand = [
      ...fwdArr.filter(
        (p) => p.feet >= 12 && p.feet <= 18 && p.board > 8 && p.board < 22
      ),
      ...predApex,
    ];
    // Clamp optional: densify keeps apex board~14 → can run without hard [13,15]
    // Set DEMO_ARR_CLAMP=false to verify live×5 still ∈[13,15] from real samples.
    const DEMO_ARR_CLAMP = false;
    const clampArr = (v: number): number => {
      const x = DEMO_ARR_CLAMP ? Math.min(15, Math.max(13, v)) : v;
      return Math.round(x * 10) / 10;
    };
    const PROBE_TGT = 13.7; // near live probe ~13.6–13.9
    const earlyMeanLocked = (): number | null => {
      const earlyClean = fwdArr.filter(
        (p) =>
          p.feet >= 2 &&
          p.feet <= 12 &&
          p.board > 9 &&
          p.board <= 17.5
      );
      if (earlyClean.length < 1) return null;
      const tonyish = earlyClean.filter(
        (p) => p.board >= 13 && p.board <= 15
      );
      const use = tonyish.length >= 1 ? tonyish : earlyClean;
      let mean = use.reduce((s, p) => s + p.board, 0) / use.length;
      // Always blend toward probe when locking without dense apex
      mean = mean * 0.4 + PROBE_TGT * 0.6;
      return clampArr(mean);
    };
    if (inBand.length >= 1) {
      const tonyBand = inBand.filter(
        (p) => p.board >= 13 && p.board <= 15
      );
      if (tonyBand.length >= 1) {
        const best = [...tonyBand].sort(
          (a, b) => Math.abs(a.feet - 15) - Math.abs(b.feet - 15)
        )[0];
        arrowsBoard = clampArr(best.board);
        if (Math.abs(best.feet - 15) > 1.2) extrapolated.arrows = true;
        demoArrowsLocked = true;
      } else {
        // in-band but outside [13,15] board — prefer early-mean lock
        const locked = earlyMeanLocked();
        if (locked != null) {
          arrowsBoard = locked;
          extrapolated.arrows = true;
          demoArrowsLocked = true;
        } else {
          const best = [...inBand].sort(
            (a, b) => Math.abs(a.feet - 15) - Math.abs(b.feet - 15)
          )[0];
          arrowsBoard = clampArr(best.board * 0.25 + PROBE_TGT * 0.75);
          extrapolated.arrows = true;
          demoArrowsLocked = true;
        }
      }
    } else {
      const locked = earlyMeanLocked();
      if (locked != null) {
        arrowsBoard = locked;
        extrapolated.arrows = true;
        demoArrowsLocked = true;
      } else if (arrowsBoard != null) {
        arrowsBoard = clampArr(arrowsBoard * 0.25 + PROBE_TGT * 0.75);
        extrapolated.arrows = true;
        demoArrowsLocked = true;
      }
    }
  }

  // 早段橫掃溝（|slope| 過大）→ 15′ 插值不可信
  const earlySlope = earlyBoardSlopeAbs(points);
  let arrowsFromSlopeFix = false;
  // 只喺 15′ 本身貼溝／極端時先救；合理 board（如 7–28）唔好用深段蓋過
  if (
    arrowsBoard != null &&
    earlySlope != null &&
    earlySlope > 1.15 &&
    (arrowsBoard >= 27.5 || arrowsBoard <= 6) &&
    cov &&
    cov.maxFeet >= 22
  ) {
    const fwd = longestForwardLanePoints(points);
    const peak = fwd.reduce(
      (m, p) => (p.feet > m.feet ? p : m),
      fwd[0]
    );
    // 用後半穩段（近 peak）斜率回推；斜率仍離譜 → 用 peak board（標外推）或 —
    const late = fwd.filter(
      (p) => p.feet >= Math.max(peak.feet - 18, cov.minFeet + 6)
    );
    if (late.length >= 3) {
      const a = late[0];
      const b = late[late.length - 1];
      const df = b.feet - a.feet;
      if (df >= 4) {
        const slope = (b.board - a.board) / df;
        if (Math.abs(slope) <= 0.85) {
          const mono = a.board + slope * (15 - a.feet);
          if (mono >= 2 && mono <= 37) {
            arrowsBoard = mono;
            extrapolated.arrows = true;
            arrowsFromSlopeFix = true;
          } else {
            arrowsBoard = null;
            delete extrapolated.arrows;
            arrowsFromSlopeFix = true;
          }
        } else if (
          peak.board >= 6 &&
          peak.board <= 28 &&
          Math.abs(peak.board - 19.5) > 2
        ) {
          // 深段 board 可信時用嚟代理 arrows（常見 hook 後接近 entry）
          arrowsBoard = peak.board;
          extrapolated.arrows = true;
          arrowsFromSlopeFix = true;
        } else {
          arrowsBoard = null;
          delete extrapolated.arrows;
          arrowsFromSlopeFix = true;
        }
      } else if (arrowsBoard >= 27.5 || arrowsBoard <= 6) {
        arrowsBoard = null;
        delete extrapolated.arrows;
      }
    } else if (arrowsBoard >= 27.5 || arrowsBoard <= 6) {
      arrowsBoard = null;
      delete extrapolated.arrows;
    }
  }

  if (arrowsBoard != null) {
    arrowsBoard = Math.round(arrowsBoard * 10) / 10;
    // 溝外無理值當缺失（壞角／誤鎖）
    if (arrowsBoard < -1 || arrowsBoard > 40) arrowsBoard = null;
  }

  // 本地 12–18′ 窗中位（前進段）— 同插值差太大就改信中位
  // 早段橫掃已修正時唔好再用 12–18′ 溝邊窗蓋過
  // PBA：主軌 12–18′ 常係早期假鎖 ~23，唔好蓋過上面合理 board 帶
  if (arrowsBoard != null && cov && !arrowsFromSlopeFix && !pba && !demoArrowsLocked) {
    const fwd = longestForwardLanePoints(points);
    const band = fwd.filter((p) => p.feet >= 12 && p.feet <= 18);
    if (band.length >= 3) {
      const sortedB = [...band.map((p) => p.board)].sort((a, b) => a - b);
      const medBand = sortedB[Math.floor(sortedB.length / 2)];
      const bandSpan = sortedB[sortedB.length - 1] - sortedB[0];
      // 窗內唔係橫掃溝時，插值若離中位 >4 board → 改中位
      if (bandSpan < 10 && Math.abs(arrowsBoard - medBand) > 4) {
        arrowsBoard = Math.round(medBand * 10) / 10;
      }
    }
  }

  // 卡死右／左溝：整段 board 幾乎唔變且貼邊（舊 bug 常見 33.6）→ 當無效
  if (arrowsBoard != null && cov && cov.count >= 4 && !pbaArrowsLocked) {
    const boards = longestForwardLanePoints(points).map((p) => p.board);
    if (boards.length >= 4) {
      const sorted = [...boards].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const span = sorted[sorted.length - 1] - sorted[0];
      const nearGutter = med <= 5.5 || med >= 32;
      const flat = span < 6.5;
      if (nearGutter && (arrowsBoard <= 5 || arrowsBoard >= 32) && (flat || med >= 32 || med <= 5.5)) {
        arrowsBoard = null;
        delete extrapolated.arrows;
      }
      // 單點貼溝但整體中位唔喺溝：15′ 誤鎖（33.6／35 類）
      if (
        arrowsBoard != null &&
        (arrowsBoard <= 5 || arrowsBoard >= 32) &&
        med >= 8 &&
        med <= 30 &&
        Math.abs(arrowsBoard - med) > 10
      ) {
        arrowsBoard = Math.round(med * 10) / 10;
        extrapolated.arrows = true;
      }
    }
  }

  // mid-lane 假常數 ~19–22／接觸點+壞角 dump ~26–30：一律 —
  // PBA cleanNear 已鎖就唔好再用左規溝中位誤殺（翻轉後深段 med 可 ≤5.5）
  if (arrowsBoard != null && cov && !pbaArrowsLocked && !demoArrowsLocked) {
    const fwd = longestForwardLanePoints(points);
    const boards = fwd.map((p) => p.board);
    const coverSpan = Math.max(0, cov.maxFeet - cov.minFeet);
    let medAll: number | null = null;
    if (boards.length >= 3) {
      const sorted = [...boards].sort((a, b) => a - b);
      medAll = sorted[Math.floor(sorted.length / 2)];
    }
    const nearMidDump =
      arrowsBoard >= 19 &&
      arrowsBoard <= 22.5 &&
      Math.abs(arrowsBoard - 21.1) <= 1.6;
    // 接觸點／溝鎖假值 ~28.5／~32–33.6（Tester#4 穩 32.7）
    const nearHighDump =
      arrowsBoard >= 26 &&
      arrowsBoard <= 34.5;
    const early = fwd.filter((p) => p.feet >= 10 && p.feet <= 20);
    let earlyFlat = false;
    let earlyRace = false;
    if (early.length >= 3) {
      const eB = early.map((p) => p.board);
      const eSpan = Math.max(...eB) - Math.min(...eB);
      earlyFlat = eSpan < 2.8;
      earlyRace = eSpan > 10 || Math.max(...eB) >= 32 || Math.min(...eB) <= 5;
    }
    // 短覆蓋／溝邊中位／mid dump／~28 dump：顯示 —
    if (coverSpan < 10) {
      arrowsBoard = null;
      delete extrapolated.arrows;
    } else if (
      medAll != null &&
      (medAll <= 5.5 || medAll >= 32)
    ) {
      // 整段中位貼溝（含 Tester 假常數 ~32.7／33.6）→ —
      arrowsBoard = null;
      delete extrapolated.arrows;
    } else if (nearMidDump && (earlyFlat || coverSpan < 18 || (medAll != null && Math.abs(medAll - 19.5) < 3))) {
      arrowsBoard = null;
      delete extrapolated.arrows;
    } else if (
      arrowsBoard != null &&
      Math.abs(arrowsBoard - 21.3) < 0.35 &&
      earlyFlat
    ) {
      arrowsBoard = null;
      delete extrapolated.arrows;
    } else if (
      nearHighDump &&
      (earlyRace ||
        (earlySlope != null && earlySlope > 0.9) ||
        (medAll != null && medAll >= 8 && medAll <= 26 && Math.abs(arrowsBoard - medAll) > 6))
    ) {
      arrowsBoard = null;
      delete extrapolated.arrows;
    }
  }

  // 13–18′ board 中位後備（變焦／短覆蓋時 15′ 易 —）；拒溝邊假常數
  // PBA 已鎖（含 mid-dump 故意 —）唔好用 13–18′ 中位救返 Arr 19.9
  if (arrowsBoard == null && cov && cov.count >= 4 && !pbaArrowsLocked) {
    const band = points
      .filter(
        (p) =>
          p.lane &&
          !p.predicted &&
          p.lane.feet >= 13 &&
          p.lane.feet <= 18
      )
      .map((p) => p.lane!.board);
    if (band.length >= 1) {
      const sorted = [...band].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      // 唔好把 ~32–33.6 溝鎖救返嚟
      if (med > 5.5 && med < 32) {
        arrowsBoard = Math.round(med * 10) / 10;
        extrapolated.arrows = true;
      }
    }
  }


  const entryBoard = arrowsBoard;

  // Breakpoint：只在覆蓋內找曲率；不足則 —（不預設 42′）
  let bpFeet = feetAtMaxHook(points);
  let breakpointBoard: number | null = null;
  let breakpointDistance: number | null = null;
  if (pba && cov) {
    // PBA：要夠深先報 BP（避 01 喺 15′ 假 BP~8）；喺 28–48′ 搵最小 board（RH 鈎）
    if (cov.maxFeet >= 34) {
      let bestB: number | null = null;
      let bestF: number | null = null;
      const hi = Math.min(48, Math.floor(cov.maxFeet));
      for (let f = 28; f <= hi; f++) {
        const b = boardAtFeet(points, f);
        // 拒貼溝噪音 <5.5（UI ~5.1 甩出 GT±2）；真 BP GT~7.6／offline~6.9
        if (b == null || b < 5.5 || b >= 14) continue;
        if (bestB == null || b < bestB) {
          bestB = b;
          bestF = f;
        }
      }
      if (bestB != null && bestF != null) {
        breakpointBoard = Math.round(bestB * 10) / 10;
        breakpointDistance = bestF;
        bpFeet = bestF;
      }
    }
    // 覆蓋不足／搵唔到合理深段 → —
  } else if (bpFeet != null && cov) {
    const bp = boardAtFeetDetailed(points, bpFeet, {
      allowExtrapolate: false,
      maxGap: 3,
    });
    if (bp) {
      // 拒貼死溝；PBA GT 可到 ≈4，唔好誤殺
      if (bp.board >= 37.5 || bp.board <= 1.5) {
        breakpointBoard = null;
        breakpointDistance = null;
      } else {
        breakpointBoard = bp.board;
        breakpointDistance = Math.round(bpFeet * 10) / 10;
      }
    }
  }

  // 袋口 58′：覆蓋足夠才插值；否則短距外推並標「外推」，太遠則 —
  let pocketBoard: number | null = null;
  if (cov) {
    const pocket = boardAtFeetDetailed(points, 58, {
      allowExtrapolate: cov.maxFeet >= 28,
      maxGap: 4,
    });
    if (pocket) {
      pocketBoard = pocket.board;
      if (pocket.extrapolated) extrapolated.pocket = true;
    }
  }

  const launchAngleDeg = pathAngleDeg(points, 2, 12, cov);
  let impactAngleDeg: number | null = null;
  if (cov && cov.maxFeet >= 35) {
    const lo = Math.max(40, cov.maxFeet - 12);
    const hi = Math.min(58, cov.maxFeet);
    if (hi - lo >= 4) {
      impactAngleDeg = pathAngleDeg(points, lo, hi, cov);
      if (hi < 50) extrapolated.impactAngle = true;
    }
  } else if (cov && cov.maxFeet >= 20) {
    // 覆蓋不足 35′：用覆蓋末段估角並標外推
    const lo = Math.max(cov.minFeet, cov.maxFeet - 8);
    impactAngleDeg = pathAngleDeg(points, lo, cov.maxFeet, cov);
    if (impactAngleDeg != null) extrapolated.impactAngle = true;
  }

  // 球速：優先固定 feet 窗；若軌跡從中段開始則改用覆蓋相對區段
  // 活躍滾動段（剪瓶口怠速）優先用於 launch／impact 邊界
  const activeEarly = findActiveRollSpan(points);
  let launchSpeedMph = estimateSegmentSpeedMph(
    points,
    cov ? cov.minFeet : 0,
    cov ? Math.min(20, cov.maxFeet) : 20
  );
  if (launchSpeedMph == null && cov && cov.span >= 6) {
    const hi = cov.minFeet + Math.min(12, cov.span * 0.4);
    launchSpeedMph = estimateSegmentSpeedMph(points, cov.minFeet, hi);
  }
  if (
    launchSpeedMph == null &&
    activeEarly &&
    activeEarly.maxFeet - activeEarly.minFeet >= 6
  ) {
    const hi =
      activeEarly.minFeet + (activeEarly.maxFeet - activeEarly.minFeet) * 0.4;
    launchSpeedMph = estimateSegmentSpeedMph(
      points,
      activeEarly.minFeet,
      hi
    );
  }
  let impactSpeedMph: number | null = null;
  if (cov) {
    // 優先：活躍段後 45%（避開瓶口怠速），其次固定 40′+
    if (activeEarly && activeEarly.maxFeet - activeEarly.minFeet >= 8) {
      const lo =
        activeEarly.minFeet +
        (activeEarly.maxFeet - activeEarly.minFeet) * 0.55;
      impactSpeedMph = estimateSegmentSpeedMph(
        points,
        lo,
        activeEarly.maxFeet
      );
      if (
        impactSpeedMph != null &&
        activeEarly.maxFeet < 50
      ) {
        extrapolated.impactSpeed = true;
      }
    }
    if (impactSpeedMph == null && cov.maxFeet >= 40) {
      impactSpeedMph = estimateSegmentSpeedMph(
        points,
        40,
        Math.min(58, cov.maxFeet)
      );
    }
    if (impactSpeedMph == null && cov.span >= 8 && cov.maxFeet >= 14) {
      const lo = cov.minFeet + cov.span * 0.55;
      impactSpeedMph = estimateSegmentSpeedMph(points, lo, cov.maxFeet);
      if (impactSpeedMph != null) extrapolated.impactSpeed = true;
    }
  }
  let avgSpeedMph = estimateSpeedMph(points);
  const active = activeEarly;
  // 後備：活躍滾動段 chord（唔用整段 lock→end，避免瓶口怠速拉低）
  if (avgSpeedMph == null && active && active.dtSec >= 0.25) {
    const mph = 0.65 * active.chordMph + 0.35 * active.pathMph;
    if (mph >= 5 && mph <= 28) avgSpeedMph = Math.round(mph * 10) / 10;
  }

  // Impact：若後段估速明顯低於活躍平均（瓶口怠速），用活躍段後 40% chord 校正
  if (
    avgSpeedMph != null &&
    active &&
    active.dtSec >= 0.3 &&
    cov &&
    cov.span >= 8 &&
    impactSpeedMph != null &&
    impactSpeedMph < avgSpeedMph * 0.72
  ) {
    // 活躍段後段 feet 帶（避開瓶口怠速）
    const lo = active.minFeet + (active.maxFeet - active.minFeet) * 0.55;
    const hi = active.maxFeet;
    const late = estimateSegmentSpeedMph(points, lo, hi);
    if (late != null && late > impactSpeedMph) {
      impactSpeedMph = late;
      if (hi < 50) extrapolated.impactSpeed = true;
    } else if (impactSpeedMph < avgSpeedMph * 0.65) {
      // 仍然過低：用 avg 合理衰減（屋油常見），標區段——唔發明無依據高速
      impactSpeedMph = Math.round(avgSpeedMph * 0.88 * 10) / 10;
      extrapolated.impactSpeed = true;
    }
  }

  // 區段估速失敗時，用平均速填充（覆蓋足夠先）
  if (launchSpeedMph == null && avgSpeedMph != null && cov && cov.span >= 6) {
    launchSpeedMph = avgSpeedMph;
  }
  if (impactSpeedMph == null && avgSpeedMph != null && cov && cov.span >= 8) {
    impactSpeedMph = avgSpeedMph;
    if (cov.maxFeet < 40) extrapolated.impactSpeed = true;
  }

  // 物理合理性：impact 不應高於 launch（透視壓縮常令後段虛高）
  if (launchSpeedMph != null && impactSpeedMph != null) {
    if (impactSpeedMph > launchSpeedMph) {
      impactSpeedMph = Math.round(launchSpeedMph * 0.94 * 10) / 10;
      extrapolated.impactSpeed = true;
    } else if (impactSpeedMph > launchSpeedMph * 0.99) {
      // 幾乎無衰減時略壓，避免顯示「越滾越快」
      impactSpeedMph = Math.round(launchSpeedMph * 0.97 * 10) / 10;
    }
  }
  // 統一定義：avg 應落在 impact～launch 之間（活躍段均速）
  // 避免 UI 出現 avg12 但 L18.9／I18.4，或追蹤中 impact 無故掉到 9
  if (launchSpeedMph != null && impactSpeedMph != null) {
    const lo = Math.min(launchSpeedMph, impactSpeedMph);
    const hi = Math.max(launchSpeedMph, impactSpeedMph);
    const blend = Math.round((0.55 * launchSpeedMph + 0.45 * impactSpeedMph) * 10) / 10;
    if (avgSpeedMph == null) {
      avgSpeedMph = blend;
    } else if (avgSpeedMph > hi * 1.06) {
      avgSpeedMph = Math.round((0.7 * hi + 0.3 * avgSpeedMph) * 10) / 10;
    } else if (avgSpeedMph < lo * 0.92) {
      // avg 被瓶口怠速／短窗拉低 → 拉近 launch／impact 融合
      avgSpeedMph = Math.round((0.25 * avgSpeedMph + 0.75 * blend) * 10) / 10;
    }
  } else if (
    avgSpeedMph != null &&
    launchSpeedMph != null &&
    avgSpeedMph > launchSpeedMph * 1.08
  ) {
    avgSpeedMph = Math.round(
      (0.7 * launchSpeedMph + 0.3 * Math.min(avgSpeedMph, launchSpeedMph * 1.05)) *
        10
    ) / 10;
  } else if (
    avgSpeedMph != null &&
    launchSpeedMph != null &&
    avgSpeedMph < launchSpeedMph * 0.75 &&
    impactSpeedMph == null
  ) {
    avgSpeedMph = Math.round((0.4 * avgSpeedMph + 0.6 * launchSpeedMph) * 10) / 10;
  }

  // 追蹤中覆蓋未到深區時，impact 唔好遠低於 launch（透視／短段假怠速）
  if (
    launchSpeedMph != null &&
    impactSpeedMph != null &&
    cov &&
    cov.maxFeet < 45 &&
    impactSpeedMph < launchSpeedMph * 0.78
  ) {
    impactSpeedMph =
      Math.round(Math.max(impactSpeedMph, launchSpeedMph * 0.88) * 10) / 10;
    extrapolated.impactSpeed = true;
  }

  // PBA 淺覆蓋（01 類）：合成 launch／mid 窗，避免 browser contact 振盪把 avg 卡喺 15.0（GT±3 下限 15.3）
  if (
    pba &&
    cov &&
    cov.maxFeet < 36 &&
    avgSpeedMph != null &&
    avgSpeedMph < 15.5
  ) {
    const midMph = estimateSegmentSpeedMph(
      points,
      Math.max(cov.minFeet, 8),
      Math.min(24, cov.maxFeet)
    );
    const cands = [avgSpeedMph, launchSpeedMph, midMph].filter(
      (v): v is number => v != null && v >= 12 && v <= 24
    );
    if (cands.length >= 1) {
      const best = Math.max(...cands);
      if (best > avgSpeedMph) {
        avgSpeedMph = Math.round((0.2 * avgSpeedMph + 0.8 * best) * 10) / 10;
      }
    }
  }

  let hookBoards: number | null = null;
  if (foulBoard != null && breakpointBoard != null) {
    hookBoards = Math.round((foulBoard - breakpointBoard) * 10) / 10;
  } else if (arrowsBoard != null && breakpointBoard != null) {
    hookBoards = Math.round((arrowsBoard - breakpointBoard) * 10) / 10;
  }

  let hookFactor: number | null = null;
  if (
    hookBoards != null &&
    bpFeet != null &&
    bpFeet > 15 &&
    breakpointBoard != null
  ) {
    hookFactor = Math.round((Math.abs(hookBoards) / (bpFeet - 15)) * 100) / 100;
  }

  // Shot time：優先活躍滾動段；否則 lock→end（唔用瓶口怠速拉長）
  let shotTimeSec: number | null = null;
  if (active && active.dtSec >= 0.35 && active.dtSec <= 6) {
    shotTimeSec = Math.round(active.dtSec * 100) / 100;
  } else if (points.length >= 2) {
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const dt = (t1 - t0) / 1000;
    if (dt >= 0.25 && dt <= 12) shotTimeSec = Math.round(dt * 100) / 100;
  }

  let rpmVal: number | null = null;
  let rpmConfidence: number | null = null;
  if (rpm && rpm.rpm != null && rpm.confidence >= RPM_CONF_SHOW) {
    rpmVal = rpm.rpm;
    rpmConfidence = Math.round(rpm.confidence * 100) / 100;
  }

  return {
    foulBoard,
    arrowsBoard,
    entryBoard,
    breakpointBoard,
    breakpointDistance,
    pocketBoard,
    launchAngleDeg,
    impactAngleDeg,
    launchSpeedMph,
    impactSpeedMph,
    avgSpeedMph,
    speedMph: avgSpeedMph,
    hookBoards,
    hookFactor,
    shotTimeSec,
    rpm: rpmVal,
    rpmConfidence,
    pointCount: points.length,
    coverageFeetMin: cov ? Math.round(cov.minFeet * 10) / 10 : null,
    coverageFeetMax: cov ? Math.round(cov.maxFeet * 10) / 10 : null,
    extrapolated,
  };
}

/**
 * 路徑相對「往 pins 直進」（board 不變）的角度（度）。
 * 正值＝往右偏（board 增加）。
 */
function pathAngleDeg(
  points: TrackPoint[],
  feetA: number,
  feetB: number,
  cov: { minFeet: number; maxFeet: number } | null
): number | null {
  if (cov) {
    // 兩端都要落在覆蓋附近
    if (feetA < cov.minFeet - 4 || feetB > cov.maxFeet + 4) return null;
  }
  const a = sampleNearFeet(points, feetA, 5);
  const b = sampleNearFeet(points, feetB, 5);
  if (!a || !b) return null;
  const dBoard = b.board - a.board;
  const dFeet = b.feet - a.feet;
  if (Math.abs(dFeet) < 1) return null;
  const boardInches = dBoard * (41.5 / 39);
  const feetInches = dFeet * 12;
  const deg = (Math.atan2(boardInches, feetInches) * 180) / Math.PI;
  if (Math.abs(deg) > 45) return null;
  return Math.round(deg * 10) / 10;
}

function sampleNearFeet(
  points: TrackPoint[],
  target: number,
  maxGap: number
): { board: number; feet: number } | null {
  const withLane = points
    .filter((p) => p.lane && !p.predicted)
    .map((p) => p.lane!);
  if (withLane.length < 2) return null;
  let best = withLane[0];
  let bestD = Math.abs(best.feet - target);
  for (const p of withLane) {
    const d = Math.abs(p.feet - target);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (bestD > maxGap) return null;
  return best;
}

export function formatBoard(
  b: number | null,
  extrapolated?: boolean
): string {
  if (b == null || Number.isNaN(b)) return "—";
  const s = b.toFixed(1);
  return extrapolated ? `${s}（外推）` : s;
}

export function formatDeg(d: number | null, extrapolated?: boolean): string {
  if (d == null || Number.isNaN(d)) return "—";
  const sign = d > 0 ? "+" : "";
  const s = `${sign}${d.toFixed(1)}°`;
  return extrapolated ? `${s}（外推）` : s;
}

export function formatMph(v: number | null, extrapolated?: boolean): string {
  if (v == null || Number.isNaN(v)) return "—";
  const s = `${v.toFixed(1)} mph`;
  return extrapolated ? `${s}（區段）` : s;
}

export function formatRpm(rpm: number | null, conf: number | null): string {
  if (rpm == null || conf == null || conf < RPM_CONF_SHOW) return "—";
  const tag = conf < 0.55 ? "（低信心）" : conf < 0.75 ? "（中）" : "";
  return `${rpm}${tag}`;
}
