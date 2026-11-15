import type { Role } from "@/lib/auth/rbac";

/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "Field Service Dispatch";

export const APP_DESCRIPTION = "Part of the Breakthru Ventures 30 apps in 30 days portfolio.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. Each link shows only for the roles listed; pages still enforce the role themselves. */
export const NAV_LINKS: { href: string; label: string; roles: readonly Role[] }[] = [
  { href: "/board", label: "Board", roles: ["dispatcher"] },
  { href: "/jobs", label: "Jobs", roles: ["dispatcher"] },
  { href: "/customers", label: "Customers", roles: ["dispatcher"] },
  { href: "/parts", label: "Parts", roles: ["dispatcher"] },
  { href: "/tech", label: "My jobs", roles: ["technician"] },
  { href: "/admin", label: "Admin", roles: ["admin"] },
];
