"use client";

import { useEffect, useRef } from "react";

// Bump this when the notice changes, so everyone sees the new version once.
const SEEN_KEY = "rec-tracker:about-seen:v1";

// The notice every visitor sees on their first visit, and can reopen from the footer.
export function AboutDialog() {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "yes";
    } catch {
      // Storage blocked (private browsing): show the notice every visit.
    }
    if (!seen) dialog.current?.showModal();
  }, []);

  function close() {
    try {
      localStorage.setItem(SEEN_KEY, "yes");
    } catch {}
    dialog.current?.close();
  }

  return (
    <>
      <button className="about-link" onClick={() => dialog.current?.showModal()}>
        About this count
      </button>
      <dialog ref={dialog} className="about" aria-labelledby="about-title" onClose={close}>
        <h2 id="about-title">Before you check the count</h2>
        <p>
          <strong>It&rsquo;s a student project.</strong> Rec Tracker is built and run by a Rice student. It isn&rsquo;t
          an official Rice University or Rice Recreation service.
        </p>
        <p>
          <strong>It doesn&rsquo;t collect anything about you.</strong> The sensors at the turnstiles only measure
          distance: no cameras, no ID swipes, no names. This site has no accounts, cookies or tracking.
        </p>
        <p>
          <strong>The number is an estimate.</strong> Sensors can miss someone or count a group as one person, so treat
          it as a rough guide to how busy the Rec is. It starts again from zero every night.
        </p>
        <p>
          Questions or ideas? Email <a href="mailto:rz68@rice.edu">rz68@rice.edu</a>.
        </p>
        <button className="about-close" onClick={close} autoFocus>
          Got it
        </button>
      </dialog>
    </>
  );
}
