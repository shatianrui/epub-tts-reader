import type { Metadata } from "next";
import { Fraunces, Source_Sans_3 } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { PlatformBody } from "@/components/PlatformBody";

const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const body = Source_Sans_3({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "听页 ListenPage · EPUB 朗读",
  description:
    "上传 EPUB，支持 MiniMax 与 Grok TTS 语音合成朗读，断点续读与云端同步。",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#eef3f0",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={`${display.variable} ${body.variable} h-full`}>
      <body className="min-h-full antialiased">
        <PlatformBody>
          <AuthProvider>{children}</AuthProvider>
        </PlatformBody>
      </body>
    </html>
  );
}
