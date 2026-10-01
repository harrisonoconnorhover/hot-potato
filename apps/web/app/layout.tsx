import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./smart-router.css";

export const metadata: Metadata = {
  title: "Hot Potato — Routing workspace",
  description: "Explainable inbound lead routing for GTM teams.",
  icons: { icon: "/hot-potato-mascot.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
