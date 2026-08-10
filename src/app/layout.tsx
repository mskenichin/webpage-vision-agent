import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Webpage Vision Agent",
  description: "Lexus公式サイトをAIと一緒に探索するビジュアルエージェント",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
