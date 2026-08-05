import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Makefigma — 测试工作区",
  description: "匿名设计文档测试工作区。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
