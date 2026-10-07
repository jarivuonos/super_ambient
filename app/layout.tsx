import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Potilastyötila (demo)",
  description: "Synteettinen FHIR-potilastyötila ja ambient-kirjaamisen demo",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fi" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
