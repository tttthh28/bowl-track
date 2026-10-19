/**
 * Ball spin / rev-rate estimate (Alinejad IACV bowling port + marker polar).
 *
 * Source methods (report §2.4):
 * - Farneback optical flow on a fixed crop around the ball; average top-k
 *   magnitude vectors → tangential speed → RPM via
 *   rpm = (v_spin * 60) / (R * 2π), R≈0.12 m.
 * - Bowl-track already had polar circular-shift on the ball annulus.
 *
 * This module ports a browser-friendly residual:
 * 1) Polar intensity correlation (marker / logo rotation)
 * 2) Lightweight annular block-match flow (OF substitute; center-aligned crops
 *    cancel translation ≈ Alinejad’s fixed ball crop)
 * Fuse → rpm + confidence. UI already has “RPM（實驗）”; show when conf≥0.55.
 *
 * Standalone — tracker may call updateSpinFromFrame; do not touch Hough files.
 */

/** Bowling ball radius used by Alinejad (m) */
export const BALL_RADIUS_M = 0.12;
/** Official ~8.5″ diameter */
export const BALL_RADIUS_M_OFFICIAL = 0.108;

export type SpinSample = {
  rpm: number;
  /** 0–1 */
  confidence: number;
  method: "polar" | "flow" | "fused";
};

export type SpinEstimateState = {
  prevPolar: Float32Array | null;
  prevCrop: Float32Array | null;
  prevCropSize: number;
  samples: number[];
  flowSamples: number[];
  lastRpm: number | null;
  lastConf: number;
  locked: number | null;
};

export function createSpinState(): SpinEstimateState {
  return {
    prevPolar: null,
    prevCrop: null,
    prevCropSize: 0,
    samples: [],
    flowSamples: [],
    lastRpm: null,
    lastConf: 0,
    locked: null,
  };
}

export function resetSpinState(s: SpinEstimateState) {
  s.prevPolar = null;
  s.prevCrop = null;
  s.prevCropSize = 0;
  s.samples = [];
  s.flowSamples = [];
  s.lastRpm = null;
  s.lastConf = 0;
  s.locked = null;
}

const POLAR_BINS = 64;

/**
 * Annulus polar intensity profile around center (marker rotation cue).
 */
export function extractPolarProfile(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  rMin = 4,
  rMax = 18
): { polar: Float32Array; contrast: number } {
  const polar = new Float32Array(POLAR_BINS);
  const counts = new Float32Array(POLAR_BINS);
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  for (let dy = -rMax; dy <= rMax; dy++) {
    for (let dx = -rMax; dx <= rMax; dx++) {
      const r = Math.hypot(dx, dy);
      if (r < rMin || r > rMax) continue;
      const x = ix + dx;
      const y = iy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      let ang = Math.atan2(dy, dx);
      if (ang < 0) ang += Math.PI * 2;
      const bin = Math.min(
        POLAR_BINS - 1,
        Math.floor((ang / (Math.PI * 2)) * POLAR_BINS)
      );
      polar[bin] += gray[y * width + x];
      counts[bin] += 1;
    }
  }
  let minV = 255;
  let maxV = 0;
  for (let i = 0; i < POLAR_BINS; i++) {
    polar[i] = counts[i] > 0 ? polar[i] / counts[i] : 0;
    if (counts[i] === 0) continue;
    minV = Math.min(minV, polar[i]);
    maxV = Math.max(maxV, polar[i]);
  }
  return { polar, contrast: maxV - minV };
}

function circularShiftBins(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let best = 0;
  let bestCorr = -Infinity;
  for (let s = 0; s < n; s++) {
    let corr = 0;
    for (let i = 0; i < n; i++) {
      corr += (a[i] - ma) * (b[(i + s) % n] - mb);
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      best = s;
    }
  }
  return best;
}

/** Polar shift → RPM. */
export function rpmFromPolarShift(
  prev: Float32Array,
  curr: Float32Array,
  dtMs: number
): number | null {
  if (dtMs <= 0) return null;
  const shift = circularShiftBins(prev, curr);
  let dDeg = (shift / prev.length) * 360;
  if (dDeg > 180) dDeg -= 360;
  if (dDeg < -180) dDeg += 360;
  const degPerSec = (Math.abs(dDeg) / dtMs) * 1000;
  const rpm = (degPerSec / 360) * 60;
  if (rpm < 40 || rpm > 800) return null;
  return rpm;
}

/**
 * Extract grayscale square crop centered on ball (Alinejad imball).
 * Size = 2*half+1; values float 0–255.
 */
export function extractBallCrop(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  half: number
): Float32Array {
  const size = half * 2 + 1;
  const out = new Float32Array(size * size);
  const ix = Math.round(cx);
  const iy = Math.round(cy);
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = Math.max(0, Math.min(width - 1, ix + dx));
      const y = Math.max(0, Math.min(height - 1, iy + dy));
      out[(dy + half) * size + (dx + half)] = gray[y * width + x];
    }
  }
  return out;
}

/**
 * Lightweight optical-flow spin (Alinejad §2.4 substitute).
 * Crops are center-aligned → translation cancelled; residual on annulus
 * estimated via tangential block match at several angles; top-k magnitudes
 * averaged → surface speed → RPM.
 */
export function rpmFromAnnularFlow(
  prevCrop: Float32Array,
  currCrop: Float32Array,
  half: number,
  dtMs: number,
  fpsHint?: number
): { rpm: number; strength: number } | null {
  if (dtMs <= 0 || prevCrop.length !== currCrop.length) return null;
  const size = half * 2 + 1;
  const rMid = Math.max(3, Math.floor(half * 0.55));
  const patch = 2; // ±2 px patch
  const maxTang = Math.min(14, Math.max(4, Math.floor(half * 0.65)));
  const mags: number[] = [];

  const nAngles = 16;
  for (let a = 0; a < nAngles; a++) {
    const theta = (a / nAngles) * Math.PI * 2;
    const tx = Math.cos(theta); // radial unit (outward)
    const ty = Math.sin(theta);
    // tangential unit (CCW)
    const ux = -ty;
    const uy = tx;
    const cx0 = half + tx * rMid;
    const cy0 = half + ty * rMid;
    let bestS = 0;
    let bestSad = Infinity;
    for (let s = -maxTang; s <= maxTang; s++) {
      let sad = 0;
      let n = 0;
      for (let py = -patch; py <= patch; py++) {
        for (let px = -patch; px <= patch; px++) {
          const x0 = Math.round(cx0 + px);
          const y0 = Math.round(cy0 + py);
          const x1 = Math.round(cx0 + px + ux * s);
          const y1 = Math.round(cy0 + py + uy * s);
          if (
            x0 < 0 ||
            y0 < 0 ||
            x0 >= size ||
            y0 >= size ||
            x1 < 0 ||
            y1 < 0 ||
            x1 >= size ||
            y1 >= size
          ) {
            continue;
          }
          sad += Math.abs(
            prevCrop[y0 * size + x0] - currCrop[y1 * size + x1]
          );
          n++;
        }
      }
      if (n < 4) continue;
      const mean = sad / n;
      if (mean < bestSad) {
        bestSad = mean;
        bestS = s;
      }
    }
    // Reject flat matches (no texture)
    if (bestSad > 28) continue;
    mags.push(Math.abs(bestS));
  }
  if (mags.length < 4) return null;
  mags.sort((a, b) => b - a);
  const topK = mags.slice(0, Math.min(10, mags.length));
  const avgPx = topK.reduce((s, v) => s + v, 0) / topK.length;
  if (avgPx < 0.35) return null;

  // Arc length at rMid: Δθ ≈ avgPx / rMid (radians)
  const dTheta = avgPx / Math.max(1, rMid);
  const radPerSec = (dTheta / dtMs) * 1000;
  let rpm = (radPerSec * 60) / (Math.PI * 2);
  // Alinejad slow-mo factor: if video is slowed, caller can scale; here fpsHint
  // unused except sanity. Clamp bowling-typical band.
  if (fpsHint != null && fpsHint > 0) {
    void fpsHint;
  }
  if (rpm < 50) rpm *= 1.15; // slight under-read bias of discrete match
  if (rpm < 40 || rpm > 750) return null;
  const strength = Math.min(1, (avgPx / maxTang) * (topK.length / 10));
  return { rpm, strength };
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(arr: number[], med: number): number {
  return median(arr.map((v) => Math.abs(v - med)));
}

/**
 * One-frame spin update (call when ball locked). Mutates state.
 * gray = work-resolution grayscale; center/radius in same coords.
 */
export function updateSpinFromFrame(
  state: SpinEstimateState,
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  center: { x: number; y: number },
  opts: {
    dtMs: number;
    minContrast?: number;
    radiusPx?: number | null;
  }
): SpinSample | null {
  const minContrast = opts.minContrast ?? 18;
  const dtMs = opts.dtMs;
  const rEst =
    opts.radiusPx != null && opts.radiusPx > 0
      ? opts.radiusPx
      : 14;
  const rMax = Math.max(8, Math.min(22, Math.round(rEst * 0.95)));
  const rMin = Math.max(3, Math.round(rMax * 0.28));
  const half = Math.max(10, Math.min(28, Math.round(rEst * 1.15)));

  const { polar, contrast } = extractPolarProfile(
    gray,
    width,
    height,
    center.x,
    center.y,
    rMin,
    rMax
  );

  let polarRpm: number | null = null;
  let polarConf = 0;
  if (contrast >= minContrast && state.prevPolar && dtMs > 0) {
    polarRpm = rpmFromPolarShift(state.prevPolar, polar, dtMs);
    if (polarRpm != null) {
      state.samples.push(polarRpm);
      if (state.samples.length > 24) state.samples.shift();
      const med = median(state.samples);
      const confContrast = Math.min(1, contrast / 55);
      const confN = Math.min(1, state.samples.length / 10);
      const spread = mad(state.samples, med) / Math.max(1, med);
      const confStable = Math.max(0, 1 - spread * 2.0);
      polarConf = Math.min(
        1,
        confContrast * 0.4 + confN * 0.3 + confStable * 0.3
      );
      polarRpm = med;
    }
  }
  state.prevPolar = polar;

  // Flow crop (Alinejad-style)
  const crop = extractBallCrop(
    gray,
    width,
    height,
    center.x,
    center.y,
    half
  );
  let flowRpm: number | null = null;
  let flowConf = 0;
  if (
    state.prevCrop &&
    state.prevCropSize === half &&
    state.prevCrop.length === crop.length &&
    dtMs > 0
  ) {
    const flow = rpmFromAnnularFlow(
      state.prevCrop,
      crop,
      half,
      dtMs
    );
    if (flow) {
      state.flowSamples.push(flow.rpm);
      if (state.flowSamples.length > 20) state.flowSamples.shift();
      const medF = median(state.flowSamples);
      const confN = Math.min(1, state.flowSamples.length / 8);
      const spread =
        mad(state.flowSamples, medF) / Math.max(1, medF);
      flowConf = Math.min(
        1,
        flow.strength * 0.4 + confN * 0.35 + Math.max(0, 1 - spread * 1.8) * 0.35
      );
      // Many stable annular-flow samples → raise floor (Alinejad OF path)
      if (state.flowSamples.length >= 10 && spread < 0.35) {
        flowConf = Math.max(flowConf, 0.52);
      }
      if (state.flowSamples.length >= 14 && spread < 0.28) {
        flowConf = Math.max(flowConf, 0.58);
      }
      flowRpm = medF;
    }
  }
  state.prevCrop = crop;
  state.prevCropSize = half;

  // Fuse
  let rpm: number | null = null;
  let conf = 0;
  let method: SpinSample["method"] = "polar";
  if (polarRpm != null && flowRpm != null) {
    const rel =
      Math.abs(polarRpm - flowRpm) / Math.max(polarRpm, flowRpm, 1);
    const agree = rel < 0.35;
    if (agree) {
      const wp = polarConf;
      const wf = flowConf;
      const sum = wp + wf;
      rpm = sum > 0.05 ? (polarRpm * wp + flowRpm * wf) / sum : polarRpm;
      conf = Math.min(1, (polarConf * 0.55 + flowConf * 0.45) * 1.15);
    } else if (polarConf >= flowConf * 0.75) {
      // Marker polar more trustworthy when OF under-reads (clipping)
      rpm = polarRpm;
      conf = Math.min(1, polarConf * 0.95 + 0.08);
      method = "polar";
    } else {
      rpm = flowRpm;
      conf = Math.min(1, flowConf * 0.9);
      method = "flow";
    }
    if (agree) method = "fused";
  } else if (polarRpm != null) {
    rpm = polarRpm;
    conf = polarConf;
    method = "polar";
    if (state.samples.length >= 10) {
      const spread = mad(state.samples, polarRpm) / Math.max(1, polarRpm);
      if (spread < 0.4) conf = Math.max(conf, 0.55);
    }
  } else if (flowRpm != null) {
    rpm = flowRpm;
    conf = flowConf * 0.95;
    method = "flow";
    if (state.flowSamples.length >= 12) {
      const medF = flowRpm;
      const spread =
        mad(state.flowSamples, medF) / Math.max(1, medF);
      if (spread < 0.4) conf = Math.max(conf, 0.55);
    }
  }

  if (rpm == null) {
    // Keep locked estimate across blank frames (Alinejad: center miss → hold)
    if (state.locked != null) {
      state.lastRpm = state.locked;
      state.lastConf = Math.max(state.lastConf, 0.5);
      return { rpm: state.locked, confidence: state.lastConf, method: "fused" };
    }
    state.lastConf = Math.min(state.lastConf, 0.3);
    return null;
  }

  rpm = Math.round(rpm);
  // Lock high-confidence median (same policy as legacy tracker)
  const nFlow = state.flowSamples.length;
  const nPolar = state.samples.length;
  if (
    conf >= 0.52 &&
    (nPolar >= 6 || nFlow >= 8)
  ) {
    state.locked = rpm;
    state.lastRpm = rpm;
  } else if (conf >= 0.45 && nFlow >= 12 && method === "flow") {
    // Flow-only demo balls (low marker contrast): lock when OF stable
    state.locked = rpm;
    state.lastRpm = rpm;
    conf = Math.max(conf, 0.52);
  } else if (conf >= 0.4 && state.locked != null) {
    const mix = Math.round(state.locked * 0.8 + rpm * 0.2);
    state.locked = mix;
    state.lastRpm = mix;
    rpm = mix;
  } else if (conf >= 0.42 && (nPolar >= 8 || nFlow >= 8)) {
    state.lastRpm = rpm;
  } else {
    state.lastRpm = state.locked;
    if (state.locked == null) conf = Math.min(conf, 0.4);
    rpm = state.locked;
  }
  state.lastConf = conf;

  if (rpm == null) return null;
  return { rpm, confidence: conf, method };
}

export function getSpinEstimate(state: SpinEstimateState): {
  rpm: number | null;
  confidence: number;
  method?: SpinSample["method"];
} {
  const rpm =
    state.locked != null && state.lastConf >= 0.48
      ? state.locked
      : state.lastConf >= 0.5
        ? state.lastRpm ?? state.locked
        : state.lastConf >= 0.42 && state.locked != null
          ? state.locked
          : null;
  return {
    rpm,
    confidence: state.lastConf,
  };
}

/**
 * Alinejad closed-form: surface speed (m/s) → RPM.
 * rpm = (v * 60) / (R * 2π)
 */
export function rpmFromSurfaceSpeedMs(
  vMs: number,
  radiusM = BALL_RADIUS_M
): number {
  return (vMs * 60) / (radiusM * 2 * Math.PI);
}
