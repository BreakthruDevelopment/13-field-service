import { describe, expect, it } from "vitest";
import { GRANTABLE_ROLES, ROLES, homeFor, isRole, toRole } from "./rbac";

describe("toRole", () => {
  it("defaults to user", () => {
    expect(toRole(null)).toBe("user");
    expect(toRole(undefined)).toBe("user");
    expect(toRole("")).toBe("user");
    expect(toRole("viewer")).toBe("user");
  });

  it("returns one role, strongest first: admin > dispatcher > technician > user", () => {
    expect(toRole("technician")).toBe("technician");
    expect(toRole("dispatcher")).toBe("dispatcher");
    expect(toRole("user, admin")).toBe("admin");
    expect(toRole("technician,dispatcher")).toBe("dispatcher");
    expect(toRole("technician, admin, dispatcher")).toBe("admin");
    expect(toRole("user,technician")).toBe("technician");
  });
});

describe("roles", () => {
  it("lists the four roles and never lets `admin` be granted through the app", () => {
    expect([...ROLES]).toEqual(["user", "technician", "dispatcher", "admin"]);
    expect((GRANTABLE_ROLES as readonly string[]).includes("admin")).toBe(false);
    expect(isRole("dispatcher")).toBe(true);
    expect(isRole("agent")).toBe(false);
  });

  it("sends each role to its home page", () => {
    expect(ROLES.map(homeFor)).toEqual(["/waiting", "/tech", "/board", "/admin"]);
  });
});
