import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Makefigma — editor alpha", description: "A Worker-driven design editor prototype." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
