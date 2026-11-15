import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/rbac";
import { type Action, type Resource, assertCan, can } from "./access";

const tech = { id: "t1", role: "technician" as const };
const dispatcher = { id: "d1", role: "dispatcher" as const };
const admin = { id: "a1", role: "admin" as const };
const user = { id: "u1", role: "user" as const };

const RESOURCES: Resource[] = ["customer", "site", "job", "job_note", "job_event", "part", "board", "work_order", "sync", "stats", "user_directory", "role", "demo"];
const ACTIONS: Action[] = ["read", "create", "update", "delete", "submit", "approve"];
const allowed = (actor: Parameters<typeof can>[0], row?: { assigneeId: string | null }) =>
  RESOURCES.flatMap((r) => ACTIONS.filter((a) => can(actor, a, r, row)).map((a) => `${r}:${a}`));

describe("access rules", () => {
  it("a plain user can do nothing", () => {
    expect(allowed(user)).toEqual([]);
  });

  it("an admin gets counts, the user directory, role grants and the demo button, and no content", () => {
    expect(new Set(allowed(admin))).toEqual(new Set(["stats:read", "user_directory:read", "role:update", "demo:create"]));
    for (const r of ["customer", "site", "job", "job_note", "job_event", "part", "board", "work_order"] as const) {
      for (const a of ACTIONS) expect(can(admin, a, r)).toBe(false);
    }
  });

  it("a dispatcher manages customers, sites, jobs and parts, and has no admin powers", () => {
    for (const r of ["customer", "site", "job", "part"] as const) expect(can(dispatcher, "read", r)).toBe(true);
    expect(can(dispatcher, "create", "customer")).toBe(true);
    expect(can(dispatcher, "update", "job")).toBe(true);
    expect(can(dispatcher, "update", "part")).toBe(true);
    for (const r of ["stats", "user_directory", "role", "demo"] as const) expect(can(dispatcher, "read", r)).toBe(false);
    expect(can(dispatcher, "update", "role")).toBe(false);
  });

  it("a technician reads parts and works only their own jobs", () => {
    expect(can(tech, "read", "part")).toBe(true);
    expect(can(tech, "create", "part")).toBe(false);
    expect(can(tech, "read", "customer")).toBe(false);
    expect(can(tech, "read", "site")).toBe(false);
    expect(can(tech, "read", "board")).toBe(false);
    expect(can(tech, "create", "job")).toBe(false);
    expect(can(tech, "update", "job")).toBe(false);
    expect(can(tech, "read", "job", { assigneeId: "t1" })).toBe(true);
    expect(can(tech, "read", "job", { assigneeId: "t2" })).toBe(false);
    expect(can(tech, "read", "job", { assigneeId: null })).toBe(false);
    expect(can(tech, "create", "job_note", { assigneeId: "t1" })).toBe(true);
    expect(can(tech, "create", "job_note", { assigneeId: "t2" })).toBe(false);
    expect(can(tech, "update", "work_order", { assigneeId: "t2" })).toBe(false);
  });

  it("the offline channel (snapshot and sync) is the technician's alone", () => {
    expect(can(tech, "read", "sync")).toBe(true);
    expect(can(tech, "create", "sync")).toBe(true);
    for (const actor of [dispatcher, admin, user]) for (const a of ACTIONS) expect(can(actor, a, "sync")).toBe(false);
    expect(() => assertCan(dispatcher, "create", "sync")).toThrow(ForbiddenError);
  });

  it("work orders: the technician submits their own, a dispatcher approves, and neither holds the other's step", () => {
    const own = { assigneeId: "t1" };
    for (const a of ["read", "create", "update", "submit"] as const) expect(can(tech, a, "work_order", own)).toBe(true);
    expect(can(tech, "approve", "work_order", own)).toBe(false);
    expect(can(tech, "submit", "work_order", { assigneeId: "t2" })).toBe(false);
    expect(can(tech, "create", "work_order", { assigneeId: null })).toBe(false);
    for (const a of ["read", "create", "update", "approve"] as const) expect(can(dispatcher, a, "work_order")).toBe(true);
    expect(can(dispatcher, "submit", "work_order")).toBe(false);
    for (const a of ACTIONS) expect(can(admin, a, "work_order")).toBe(false);
  });

  it("assertCan throws ForbiddenError (403)", () => {
    expect(() => assertCan(admin, "read", "job")).toThrow(ForbiddenError);
    expect(() => assertCan(user, "read", "part")).toThrow(ForbiddenError);
    expect(() => assertCan(tech, "read", "job", { assigneeId: "t2" })).toThrow(ForbiddenError);
    expect(() => assertCan(dispatcher, "read", "job")).not.toThrow();
  });
});
