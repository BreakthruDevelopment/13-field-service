/**
 * The one place an app names itself. The header, the page title and the sign-in
 * page all read APP_TITLE. Set APP_NAME in the environment, or change the default
 * below when an app is created from the template.
 */
export const APP_TITLE = process.env.APP_NAME || "Field Service";

export const APP_DESCRIPTION =
  "Dispatchers review jobs, check-ins and work orders, and keep the customers and sites those jobs belong to.";

export const PARENT_SITE = { href: "https://breakthruventures.ai", label: "Explore breakthruventures.ai" };

/** Header navigation. `roles` limits who sees a link; pages still enforce the role. */
export const NAV_LINKS: { href: string; label: string; adminOnly?: boolean; roles?: readonly string[] }[] = [
  { href: "/customers", label: "Customers", roles: ["dispatcher"] },
  { href: "/dashboard", label: "Dashboard", roles: ["user", "technician"] },
  { href: "/admin", label: "Admin", adminOnly: true },
];
