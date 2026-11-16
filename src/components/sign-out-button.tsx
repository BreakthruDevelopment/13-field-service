"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOutAndWipe } from "@/lib/offline/browser";
import { buttonSecondary } from "./ui/styles";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
    {failed && (
      <span role="alert" className="text-sm font-medium text-danger">
        Couldn&apos;t sign out. Try again.
      </span>
    )}
    <button
      type="button"
      disabled={pending}
      className={buttonSecondary}
      onClick={async () => {
        setPending(true);
        setFailed(false);
        try {
          // Wipes this device first (IndexedDB, caches), then signs out. Offline, the wipe still happens at once and the
          // server sign-out finishes when the app next opens online.
          const result = await signOutAndWipe();
          if (result.status === "cancelled") return;
          if (result.status === "wiped_offline" && navigator.onLine) {
            setFailed(true); // this device is wiped, but the server didn't confirm the sign-out: try again
            return;
          }
          router.push("/sign-in");
          router.refresh();
        } catch {
          setFailed(true);
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
    </>
  );
}
