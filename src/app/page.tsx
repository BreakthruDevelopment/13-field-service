import Link from "next/link";
import { PageIntro, Panel, buttonPrimary } from "@/components/ui";
import { homeFor } from "@/lib/auth/rbac";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const points = [
  {
    title: "The phone still works in the basement",
    body: "Technicians keep notes, status and check-ins on the phone with no signal. When they are back online, each change applies once.",
  },
  {
    title: "Technicians see only their jobs",
    body: "Assigned jobs, the customer phone, the site address and access notes. Someone else's job looks the same as a made-up id.",
  },
  {
    title: "Parts from the catalog, not free text",
    body: "Dispatchers keep a SKU catalog. The AI work order matches notes against those SKUs so billing and restocking are not a retype.",
  },
  {
    title: "Location only when the tech taps Check in",
    body: "No background tracking. Coordinates are stored to about 11 metres and deleted 90 days after the job is completed.",
  },
];

export default async function Home() {
  let signedInHref = "/sign-in";
  let signedInLabel = "Sign in";
  try {
    const user = await getCurrentUser();
    if (user) {
      signedInHref = homeFor(user.role);
      signedInLabel =
        user.role === "user"
          ? "Waiting for access"
          : user.role === "admin"
            ? "Open admin"
            : user.role === "technician"
              ? "Open my jobs"
              : "Open the board";
    }
  } catch {
    // A database blip must not take the public landing down with it.
  }

  return (
    <>
      <PageIntro
        section="Field Service"
        title="Dispatch for a 10-truck shop."
        description="Book jobs, put them on technicians' days, and keep notes and parts lists accurate even when the phone has no signal. New sign-ups wait until an admin grants technician or dispatcher."
        actions={
          <Link href={signedInHref} className={buttonPrimary}>
            {signedInLabel}
          </Link>
        }
      />
      <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
        {points.map((p) => (
          <Panel key={p.title} title={p.title}>
            <p className="min-w-0 break-words text-muted">{p.body}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}
