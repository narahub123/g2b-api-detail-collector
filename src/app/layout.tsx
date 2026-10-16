import type { Metadata } from "next";
import "./globals.css";
import "./source-comparison.css";

export const metadata: Metadata = {
  title: "나라장터 용역 입찰공고",
  description: "용역 입찰공고를 수집하고 핵심 정보를 확인하는 로컬 앱"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
