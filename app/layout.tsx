import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "BlackBox",
  description:
    "Voice-native flight recorder for EMS crews. One in seven NYC EMS calls is dispatched as the wrong thing.",
};

// Only html/body, base classes and metadata. PHASE-13 renders app/voice/** inside this
// layout, so a viewport lock here would silently break a page written by another agent.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-bb-bg text-bb-text font-sans antialiased">{children}</body>
    </html>
  );
}
