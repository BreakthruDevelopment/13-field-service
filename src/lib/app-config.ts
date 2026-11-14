/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "Field Service";

export const APP_DESCRIPTION =
  "Technicians keep their assigned jobs, notes, and check-ins on the phone, including when the site has no signal.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. `roles` limits who sees a link; pages still enforce the role. */
export const NAV_LINKS: { href: string; label: string; adminOnly?: boolean; roles?: readonly string[] }[] = [
  { href: "/tech", label: "My jobs", roles: ["technician"] },
  { href: "/dashboard", label: "Dashboard", roles: ["dispatcher", "admin"] },
  { href: "/admin", label: "Admin", adminOnly: true },
];
