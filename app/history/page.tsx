import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { HistoryView } from "./history-view";

export const metadata: Metadata = {
  title: "Rec Tracker history: how busy the Rice Rec has been",
  description: "How many people were in the Rice Rec through any past day, and how busy it usually is by weekday and hour.",
};

export default function HistoryPage() {
  return (
    <main className="history">
      <header className="public-head">
        <Link href="/" className="wordmark wordmark-link">
          Rec Tracker
        </Link>
        <Link href="/" className="back-link">
          Live count
        </Link>
      </header>
      <h1 className="history-title">History</h1>
      <Suspense fallback={<p className="hint">Loading…</p>}>
        <HistoryView />
      </Suspense>
    </main>
  );
}
