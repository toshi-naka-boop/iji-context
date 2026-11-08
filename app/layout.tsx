import "./globals.css";

export const metadata = { title: "レセメン" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/* 文字：本文は Inter と Noto Sans JP、数字は Rajdhani（2026-11-08 案 C+） */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Noto+Sans+JP:wght@400;500;700&family=Rajdhani:wght@600;700&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
