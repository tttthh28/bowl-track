import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bowl Track — 保齡球球路追蹤",
  description:
    "瀏覽器端保齡球球路追蹤：自動／手動四角、穩健追球、LaneTrax 風格指標與實驗性 RPM。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#020617",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="min-h-dvh antialiased safe-pb">{children}</body>
    </html>
  );
}
