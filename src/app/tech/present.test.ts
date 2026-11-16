import { describe, expect, it } from "vitest";
import { LocalRuleError } from "@/lib/offline/rules";
import type { AttentionItem, TechJob } from "@/lib/offline/types";
import {
  attentionDetail,
  attentionHeading,
  attentionNoteBody,
  changeCount,
  formatWindow,
  groupJobs,
  jobBucket,
  needsNoteFirst,
  openStreetMapUrl,
  phoneError,
  statusButtons,
  syncChip,
} from "./present";

function job(partial: Partial<TechJob> & Pick<TechJob, "id" | "status">): TechJob {
  return {
    number: 1,
    title: "Job",
    description: "",
    priority: "normal",
    version: 1,
    statusVersion: 1,
    scheduledStart: null,
    scheduledEnd: null,
    completedAt: null,
    customer: { name: "Ada", phone: "555" },
    site: { label: "Site", address: "1 Main", accessNotes: "", lat: null, lng: null },
    notes: [],
    notesTruncated: false,
    ...partial,
  };
}

const now = new Date(2026, 10, 16, 15, 0, 0);
const iso = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h, 0, 0).toISOString();

describe("groupJobs", () => {
  it("puts active work in Today, later windows in Upcoming, and closed jobs in Recent", () => {
    const onSite = job({ id: "on-site", status: "on_site", scheduledStart: iso(2026, 10, 20), number: 2 });
    const later = job({ id: "later", status: "scheduled", scheduledStart: iso(2026, 10, 17, 9), number: 3 });
    const today = job({ id: "today", status: "scheduled", scheduledStart: iso(2026, 10, 16, 18), number: 4 });
    const overdue = job({ id: "overdue", status: "scheduled", scheduledStart: iso(2026, 10, 15, 9), number: 5 });
    const done = job({ id: "done", status: "completed", scheduledStart: iso(2026, 10, 16, 8), completedAt: iso(2026, 10, 16, 12), number: 6 });
    const cancelled = job({ id: "cancelled", status: "cancelled", number: 7 });
    const untimed = job({ id: "untimed", status: "scheduled", number: 1 });
    const input = [later, done, onSite, today, cancelled, overdue, untimed];
    const before = input.map((j) => j.id);
    const groups = groupJobs(input, now);
    expect(input.map((j) => j.id)).toEqual(before);
    expect(groups.today.map((j) => j.id)).toEqual(["on-site", "untimed", "overdue", "today"]);
    expect(groups.upcoming.map((j) => j.id)).toEqual(["later"]);
    expect(groups.recent.map((j) => j.id)).toEqual(["done", "cancelled"]);
  });

  it("treats a bad window as today so the job does not disappear", () => {
    expect(jobBucket(job({ id: "bad", status: "scheduled", scheduledStart: "not-a-date" }), now)).toBe("today");
  });
});

describe("formatWindow", () => {
  it("includes the local day and both ends of the window", () => {
    const text = formatWindow(iso(2026, 10, 16, 9), new Date(2026, 10, 16, 11, 30, 0).toISOString());
    expect(text).toContain("Nov");
    expect(text).toContain("16");
    expect(text).toContain("–");
  });

  it("says when no time is set", () => {
    expect(formatWindow(null, null)).toBe("No time set");
  });
});

describe("status buttons", () => {
  it("offers En route and Check in from scheduled, and nothing once the job is closed", () => {
    const scheduled = statusButtons("scheduled");
    expect(scheduled.map((b) => b.label)).toEqual(["En route", "Check in at site"]);
    expect(scheduled.find((b) => b.checkIn)?.to).toBe("on_site");
    expect(statusButtons("on_hold").map((b) => b.label)).toEqual(["Check in at site"]);
    expect(statusButtons("completed")).toEqual([]);
    expect(statusButtons("on_site").map((b) => b.to)).toEqual(["completed", "on_hold"]);
  });

  it("asks for a note before complete or on hold, unless older notes exist on the server", () => {
    const bare = job({ id: "bare", status: "on_site" });
    expect(needsNoteFirst(bare, "completed")).toBe(true);
    expect(needsNoteFirst(bare, "on_hold")).toBe(true);
    expect(needsNoteFirst(bare, "en_route")).toBe(false);
    expect(needsNoteFirst({ ...bare, notesTruncated: true }, "completed")).toBe(false);
    expect(needsNoteFirst({ ...bare, notes: [{ id: "n", body: "Done", clientAt: null, serverAt: iso(2026, 10, 16), byMe: true }] }, "completed")).toBe(false);
  });
});

describe("syncChip", () => {
  it("names offline, waiting, and signed-out states", () => {
    expect(syncChip({ ready: false, online: true, status: "idle", pending: 0 }).label).toBe("Loading");
    expect(syncChip({ ready: true, online: false, status: "idle", pending: 0 }).label).toBe("Offline");
    expect(syncChip({ ready: true, online: false, status: "idle", pending: 1 }).label).toBe("Offline · 1 change waiting");
    expect(syncChip({ ready: true, online: true, status: "syncing", pending: 2 }).label).toBe("Syncing");
    expect(syncChip({ ready: true, online: true, status: "backoff", pending: 2 }).tone).toBe("building");
    expect(syncChip({ ready: true, online: true, status: "signed_out", pending: 1 }).tone).toBe("blocked");
    expect(syncChip({ ready: true, online: true, status: "idle", pending: 2 }).label).toBe("2 changes waiting to sync");
    expect(syncChip({ ready: true, online: true, status: "idle", pending: 0 }).label).toBe("Up to date");
    expect(changeCount(1)).toBe("1 change");
  });
});

describe("needs attention", () => {
  const long = "A".repeat(60);
  const note: AttentionItem = {
    opId: "op-1",
    op: { kind: "note.add", opId: "op-1", jobId: "job-1", clientAt: iso(2026, 10, 16), body: long },
    label: "#4 Kitchen sink",
    outcome: "rejected",
    code: "not_assigned",
    at: 1,
  };

  it("keeps a refused note's text and says to copy it", () => {
    expect(attentionNoteBody(note)).toBe(long);
    expect(attentionHeading(note)).toContain("note not saved");
    expect(attentionDetail(note)).toContain("Copy it");
  });

  it("describes a status conflict without dropping the attempt", () => {
    const status: AttentionItem = {
      ...note,
      op: { kind: "status.set", opId: "op-2", jobId: "job-1", clientAt: iso(2026, 10, 16), to: "on_site", baseStatusVersion: 3, dependsOn: null },
      outcome: "conflict",
      code: "stale_version",
      job: { id: "job-1", status: "scheduled", statusVersion: 4, version: 8 },
    };
    expect(attentionNoteBody(status)).toBeNull();
    expect(attentionDetail(status)).toContain("office changed");
    expect(attentionHeading(status)).toContain("On site");
  });
});

describe("openStreetMapUrl", () => {
  it("uses site coordinates when they exist, including the origin", () => {
    const url = openStreetMapUrl({ address: "1 Main Street", lat: 0, lng: 0 });
    expect(url).toContain("mlat=0.00000");
    expect(url).not.toContain("Main");
  });

  it("links a search for the address when there are no coordinates", () => {
    expect(openStreetMapUrl({ address: "1 Main Street", lat: null, lng: null })).toContain(encodeURIComponent("1 Main Street"));
    expect(openStreetMapUrl({ address: "  ", lat: null, lng: null })).toBeNull();
  });
});

describe("phoneError", () => {
  it("shows a local rule and hides anything else", () => {
    expect(phoneError(new LocalRuleError("empty_note", "Note is empty"))).toBe("Note is empty");
    expect(phoneError(new Error("Offline storage isn't ready"))).toContain("isn't ready");
    expect(phoneError(new Error("connection reset by peer"))).toBe("Couldn't save that on this phone. Try again.");
  });
});
