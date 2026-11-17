"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { buttonSecondary } from "@/components/ui/styles";

/**
 * Board-level notices that outlive the card that raised them.
 *
 * An assignment conflict refreshes the board, and the refresh is often what removes the card: once the job belongs to
 * a technician it leaves the unassigned tray, taking its `AssignForm` — and any alert inside it — with it. The
 * dispatcher would then see the form vanish, which looks exactly like their own assignment succeeding. The notice
 * lives here instead, above every card, so it survives the refresh and says what actually happened.
 */
/** Show a notice, or clear the one on screen with `null` (a later success makes an earlier warning stale). */
type Notify = (message: string | null) => void;

const NoticeContext = createContext<Notify>(() => {});

export function useBoardNotice(): Notify {
  return useContext(NoticeContext);
}

export function BoardNotices({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const notify = useCallback<Notify>((next) => setMessage(next), []);
  return (
    <NoticeContext.Provider value={notify}>
      {children}
      {message === null ? null : (
        // Pinned to the viewport: the card that raised this may have been near the bottom of a long board.
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 p-3">
          <div
            role="alert"
            data-testid="board-notice"
            className="pointer-events-auto mx-auto flex min-w-0 max-w-2xl flex-wrap items-start gap-3 rounded-card border border-danger bg-surface p-3 shadow-lg"
          >
            <p className="min-w-0 flex-1 text-sm font-medium text-danger [overflow-wrap:anywhere]">{message}</p>
            <button type="button" onClick={() => setMessage(null)} className={buttonSecondary}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </NoticeContext.Provider>
  );
}
