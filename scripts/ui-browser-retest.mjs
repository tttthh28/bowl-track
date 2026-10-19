import puppeteer from "puppeteer-core";
import { writeFileSync } from "fs";

const VIDEO = "/workspace/bowl-track/test-media/bowling-demo.mp4";
const MANUAL = {
  tl: { x: 543, y: 152 }, tr: { x: 703, y: 152 },
  bl: { x: 181, y: 864 }, br: { x: 814, y: 864 },
};

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.setDefaultTimeout(60000);
await page.setViewport({ width: 1400, height: 900 });
await page.goto("http://localhost:3000/session", { waitUntil: "networkidle2" });

// Upload video via file input
const input = await page.$('input[type="file"]');
if (!input) throw new Error("no file input");
await input.uploadFile(VIDEO);
await page.waitForFunction(() => {
  const v = document.querySelector("video");
  return v && v.readyState >= 2 && v.videoWidth > 0;
}, { timeout: 20000 });
await new Promise(r => setTimeout(r, 800));

// Wait for debug API
await page.waitForFunction(() => window.__bowlDebug && typeof window.__bowlDebug.setCorners === "function", { timeout: 10000 });

await page.evaluate((corners) => {
  window.__bowlDebug.setPba(false);
  window.__bowlDebug.setCorners(corners);
}, MANUAL);
await new Promise(r => setTimeout(r, 400));

// Clear prior shots if confirm dialog - skip; start tracking
await page.evaluate(() => window.__bowlDebug.start());

// Wait up to ~25s for a saved shot (video ~8.5s, maybe 2 loops)
const deadline = Date.now() + 28000;
let last = null;
let status = "";
while (Date.now() < deadline) {
  const snap = await page.evaluate(() => ({
    last: window.__bowlDebug?.getLast?.() ?? window.__bowlLastShot ?? null,
    status: window.__bowlDebug?.getStatus?.() ?? "",
  }));
  status = snap.status;
  if (snap.last && snap.last.estimate) {
    last = snap.last;
    // wait a beat to see if panel settles
    await new Promise(r => setTimeout(r, 500));
    break;
  }
  await new Promise(r => setTimeout(r, 400));
}

await page.evaluate(() => window.__bowlDebug?.stop?.());
await new Promise(r => setTimeout(r, 300));
const final = await page.evaluate(() => ({
  last: window.__bowlDebug?.getLast?.() ?? window.__bowlLastShot ?? null,
  status: window.__bowlDebug?.getStatus?.() ?? "",
}));
if (final.last) last = final.last;
status = final.status || status;

await page.screenshot({ path: "/tmp/ui-browser-retest.png", fullPage: true });
await browser.close();

const est = last?.estimate ?? null;
const pts = last?.points ?? [];
const lane = pts.filter(p => p.lane);
const feet = lane.map(p => p.lane.feet);
const raw = pts.filter(p => p.lane && !p.predicted);
const result = {
  status,
  n: last?.n ?? pts.length,
  boardsSample: last?.boardsSample ?? null,
  cov: est ? `${est.coverageFeetMin}-${est.coverageFeetMax}` : null,
  arr: est?.arrowsBoard ?? null,
  bp: est?.breakpointBoard ?? null,
  pocket: est?.pocketBoard ?? null,
  avg: est?.avgSpeedMph ?? null,
  L: est?.launchSpeedMph ?? null,
  I: est?.impactSpeedMph ?? null,
  time: est?.shotTimeSec ?? null,
  pointCount: est?.pointCount ?? null,
  pathFt: feet.length ? `${Math.min(...feet).toFixed(1)}-${Math.max(...feet).toFixed(1)}` : "—",
  rawFt: raw.length ? `${Math.min(...raw.map(p=>p.lane.feet)).toFixed(1)}-${Math.max(...raw.map(p=>p.lane.feet)).toFixed(1)}` : "—",
  foulOk: feet.length > 0 && Math.min(...feet) <= 8,
  pinsOk: feet.length > 0 && Math.max(...feet) >= 50,
  arrOk: est?.arrowsBoard != null && est.arrowsBoard >= 13 && est.arrowsBoard <= 15,
};
console.log(JSON.stringify(result, null, 2));
writeFileSync("/tmp/ui-browser-retest.json", JSON.stringify({ result, last }, null, 2));
const pass = result.foulOk && result.pinsOk && result.arrOk && result.cov && !String(result.cov).includes("null");
console.log("UI_PASS", pass);
