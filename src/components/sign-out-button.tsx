"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOutAndWipe } from "@/lib/offline/sign-out";
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
          const result = await signOutAndWipe();
          if (result === "cancelled") return;
          if (result === "failed") {
            setFailed(true);
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
