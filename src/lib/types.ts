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
};

export type ShotEstimate = {
  /** 箭頭區約 15 feet 處 board */
  arrowsBoard: number | null;
  /** breakpoint 約 40–45 feet 處 board */
  breakpointBoard: number | null;
  /** 進袋附近約 60 feet 處 board */
  pocketBoard: number | null;
  /** 粗估球速 mph（可選） */
  speedMph: number | null;
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
  /** 灰階差閾值 8–80 */
  sensitivity: number;
  /** 最小 blob 像素數 */
  minBlobPixels: number;
  /** 球消失連續幀數後結束一投 */
  lostFramesToEnd: number;
};
