"use client";

import { useState } from "react";
import { captureCheckInLocation } from "@/lib/offline/geolocation";
import { useTechData } from "@/lib/offline/use-tech-data";

/**
 * A bare-bones technician screen for the scripted browser run (`scripts/e2e-offline.mjs`): job, status buttons, Check in,
 * a note box, the sync chip. It renders only when the server runs with `E2E_OFFLINE=1` (see `src/app/tech/layout.tsx`);
 * the real screens are 13.6's and replace nothing here. It exists so the offline stack (service worker, IndexedDB,
 * outbox, flush, logout wipe) can be driven end to end in a real browser.
 */
export function E2eOfflineHarness() {
  const data = useTechData();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const job = data.jobs[0];
  const guard = async (work: () => Promise<unknown>) => {
    setError("");
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    }
  };
  return (
    <section aria-label="offline e2e harness" className="mx-auto max-w-xl space-y-3 p-4 text-sm">
      <p data-testid="ready">{data.ready ? "ready" : "loading"}</p>
      <p data-testid="sync-status">{data.status}</p>
      <p data-testid="pending">{data.pending}</p>
      <p data-testid="attention">{data.attention.length}</p>
      {job ? (
        <div>
          <p data-testid="job-title">{job.title}</p>
          <p data-testid="job-status">{job.status}</p>
          <p data-testid="job-notes">{job.notes.map((n) => n.body).join(" | ")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => guard(() => data.setStatus(job.id, "en_route"))}>En route</button>
            <button
              type="button"
              onClick={() =>
                guard(async () => {
                  const location = await captureCheckInLocation(); // the explicit tap: one fix, never a watch
                  await data.setStatus(job.id, "on_site", { location });
                })
              }
            >
              Check in at site
            </button>
            <button type="button" onClick={() => guard(() => data.setStatus(job.id, "completed"))}>Complete</button>
          </div>
          <input aria-label="note" value={note} onChange={(e) => setNote(e.target.value)} className="border" />
          <button
            type="button"
            onClick={() =>
              guard(async () => {
                await data.addNote(job.id, note);
                setNote("");
              })
            }
          >
            Add note
          </button>
        </div>
      ) : (
        <p data-testid="no-jobs">no jobs</p>
      )}
      <p data-testid="error">{error}</p>
    </section>
  );
}
