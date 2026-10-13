import type { Metadata, Viewport } from "next";
import { Big_Shoulders, IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const display = Big_Shoulders({ variable: "--font-display", subsets: ["latin"], weight: ["700", "800"], adjustFontFallback: false });
const body = Schibsted_Grotesk({ variable: "--font-body", subsets: ["latin"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Rec Tracker: how busy is the Rice Rec right now",
  description:
    "A live count of people inside the Rice Recreation & Wellness Center, measured at the turnstiles. A student project, not an official Rice University service.",
};

export const viewport: Viewport = { themeColor: "#DCE1E6" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
