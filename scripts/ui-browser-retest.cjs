const puppeteer = require("puppeteer-core");
const { writeFileSync } = require("fs");

const VIDEO = "/workspace/bowl-track/test-media/bowling-demo.mp4";
const MANUAL = {
  tl: { x: 543, y: 152 }, tr: { x: 703, y: 152 },
  bl: { x: 181, y: 864 }, br: { x: 814, y: 864 },
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--use-gl=swiftshader", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  await page.setViewport({ width: 1400, height: 900 });
  page.on("console", (msg) => console.log("BROWSER:", msg.type(), msg.text()));
  await page.goto("http://localhost:3000/session", { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 1500));

  const info = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input[type=file]')].map(i => ({ accept: i.accept, id: i.id, className: i.className })),
    hasDebug: !!window.__bowlDebug,
    videos: [...document.querySelectorAll("video")].map(v => ({ w: v.videoWidth, rs: v.readyState, src: !!v.src })),
  }));
  console.log("PAGE", JSON.stringify(info));

  const inputs = await page.$$('input[type="file"]');
  console.log("file inputs", inputs.length);
  if (!inputs.length) throw new Error("no file input");
  await inputs[0].uploadFile(VIDEO);
  console.log("uploaded");

  // wait for video dimensions
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const v = document.querySelector("video");
      return v ? { w: v.videoWidth, h: v.videoHeight, rs: v.readyState, t: v.currentTime, dur: v.duration } : null;
    });
    console.log("video", i, st);
    if (st && st.w > 0 && st.rs >= 2) break;
    await new Promise(r => setTimeout(r, 500));
  }

  await page.waitForFunction(() => window.__bowlDebug && typeof window.__bowlDebug.setCorners === "function", { timeout: 15000 });
  await page.evaluate((corners) => {
    window.__bowlDebug.setPba(false);
    window.__bowlDebug.setCorners(corners);
  }, MANUAL);
  await new Promise(r => setTimeout(r, 500));

  // ensure video playing
  await page.evaluate(() => {
    const v = document.querySelector("video");
    if (v) { v.muted = true; v.loop = true; return v.play().catch(() => {}); }
  });
  await new Promise(r => setTimeout(r, 300));

  await page.evaluate(() => window.__bowlDebug.start());
  console.log("tracking started", await page.evaluate(() => window.__bowlDebug.getStatus()));

  const deadline = Date.now() + 30000;
  let last = null;
  let status = "";
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      last: window.__bowlDebug?.getLast?.() ?? window.__bowlLastShot ?? null,
      status: window.__bowlDebug?.getStatus?.() ?? "",
      vt: document.querySelector("video")?.currentTime,
    }));
    status = snap.status;
    if (snap.last && snap.last.estimate) {
      last = snap.last;
      console.log("GOT SHOT at vt", snap.vt, "status", status);
      break;
    }
    if (Math.floor(Date.now() / 2000) !== Math.floor((Date.now() - 400) / 2000)) {
      console.log("wait", status, "vt", snap.vt);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  await page.evaluate(() => window.__bowlDebug?.stop?.());
  await new Promise(r => setTimeout(r, 500));
  const final = await page.evaluate(() => ({
    last: window.__bowlDebug?.getLast?.() ?? window.__bowlLastShot ?? null,
    status: window.__bowlDebug?.getStatus?.() ?? "",
  }));
  if (final.last) last = final.last;
  status = final.status || status;

  await page.screenshot({ path: "/workspace/bowl-track/tmp-reports/ui-browser-retest.png", fullPage: true });
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
    cov: est && est.coverageFeetMin != null ? `${est.coverageFeetMin}-${est.coverageFeetMax}` : "—",
    arr: est?.arrowsBoard ?? null,
    bp: est?.breakpointBoard ?? null,
    pocket: est?.pocketBoard ?? null,
    avg: est?.avgSpeedMph ?? null,
    L: est?.launchSpeedMph ?? null,
    I: est?.impactSpeedMph ?? null,
    time: est?.shotTimeSec ?? null,
    pointCount: est?.pointCount ?? null,
    pathFt: feet.length ? `${Math.min(...feet).toFixed(1)}-${Math.max(...feet).toFixed(1)}` : "—",
    rawN: raw.length,
    foulOk: feet.length > 0 && Math.min(...feet) <= 8,
    pinsOk: feet.length > 0 && Math.max(...feet) >= 50,
    arrOk: est?.arrowsBoard != null && est.arrowsBoard >= 13 && est.arrowsBoard <= 15,
  };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync("/workspace/bowl-track/tmp-reports/ui-browser-retest.json", JSON.stringify({ result, last }, null, 2));
  const pass = result.foulOk && result.pinsOk && result.arrOk && result.cov !== "—";
  console.log("UI_PASS", pass);
})().catch((e) => { console.error(e); process.exit(1); });
