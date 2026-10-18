/** 影像座標（像素） */
export type Point2D = { x: number; y: number };

/** 球道座標：board 0–39（左→右）、feet 0–60（foul line → pins） */
export type LanePoint = { board: number; feet: number };

/** 四角標定：影像空間 TL, TR, BR, BL（面向球瓶） */
export type LaneCorners = {
  tl: Point2D;
  tr: Point2D;
  br: Point2D;
  bl: Point2D;
};

export type TrackPoint = {
  /** 影像像素 */
  image: Point2D;
  /** 球道座標（校準後才有） */
  lane?: LanePoint;
  /** 相對本投開始的毫秒 */
  t: number;
  /** 是否為丟幀預測點 */
  predicted?: boolean;
};

export type ShotEstimate = {
  /** Foul line 附近 board（≈0–2′） */
  foulBoard: number | null;
  /** 箭頭區約 15 feet 處 board */
  arrowsBoard: number | null;
  /** Entry board（等同箭頭區，LaneTrax 用語） */
  entryBoard: number | null;
  /** breakpoint 約 40–45 feet 處 board */
  breakpointBoard: number | null;
  /** breakpoint 距離（feet） */
  breakpointDistance: number | null;
  /** 進袋附近約 58–60 feet 處 board */
  pocketBoard: number | null;
  /** 出發角（相對中線，度；正＝往右） */
  launchAngleDeg: number | null;
  /** 進袋角（相對中線，度） */
  impactAngleDeg: number | null;
  /** 出發段球速 mph（前段） */
  launchSpeedMph: number | null;
  /** 進袋段球速 mph（後段） */
  impactSpeedMph: number | null;
  /** 全程平均球速 mph */
  avgSpeedMph: number | null;
  /** 粗估球速（相容舊欄位＝avg） */
  speedMph: number | null;
  /** Hook boards：出發 board − breakpoint board（正＝右鉤典型） */
  hookBoards: number | null;
  /** 簡化 Hook factor＝hookBoards / (BP feet − arrows feet) */
  hookFactor: number | null;
  /** 一投時長（秒） */
  shotTimeSec: number | null;
  /**
   * 實驗性轉速 RPM。
   * 需球表高對比標記；可靠度低時 confidence 低。
   */
  rpm: number | null;
  /** RPM 信心 0–1；UI 應標「實驗」 */
  rpmConfidence: number | null;
  /** 軌跡點數 */
  pointCount: number;
};

export type Shot = {
  id: string;
  createdAt: number;
  points: TrackPoint[];
  estimate: ShotEstimate;
  /** 來源：camera | upload */
  source: "camera" | "upload";
};

export type SessionRecord = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  corners: LaneCorners | null;
  shots: Shot[];
};

export type TrackerSettings = {
  /** 灰階差閾值 8–80；autoSensitivity 開啟時為基準 */
  sensitivity: number;
  /** 最小 blob 像素數 */
  minBlobPixels: number;
  /** 球消失連續幀數後結束一投 */
  lostFramesToEnd: number;
  /** 位置 EMA 平滑係數 0.1–1（越大越跟最新） */
  emaAlpha: number;
  /** 依背景雜訊微調閾值 */
  autoSensitivity: boolean;
  /** 背景模型學習率 0–0.2 */
  bgLearningRate: number;
  /** 啟用實驗性 RPM（球表標記／光流） */
  rpmEnabled: boolean;
  /** RPM：球表對比門檻（越高越嚴） */
  rpmMinContrast: number;
};
