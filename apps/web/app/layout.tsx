import type { Metadata } from "next";
import type React from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anchor",
  description: "生活节律重建系统",
  icons: {
    icon: "/icon.svg",
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
  },
};

/**
 * 根 layout：只提供 HTML 骨架和全局 CSS。
 * 导航 shell 在 (main)/layout.tsx，独立窗口在 (standalone)/layout.tsx。
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
