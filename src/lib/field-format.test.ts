import { describe, expect, it } from "vitest";
import { eventSummary, formatCheckIn, osmHref } from "./field-format";

describe("formatCheckIn", () => {
  it("matches the dispatcher sentence when accuracy and distance are known", () => {
    expect(formatCheckIn({ accuracyM: 25, distanceFromSiteM: 140, late: false })).toBe(
      "Checked in ±25 m, 140 m from site. Device-reported.",
    );
  });

  it("omits the distance when the site has no coordinates", () => {
    expect(formatCheckIn({ accuracyM: 25, distanceFromSiteM: null, late: false })).toBe(
      "Checked in ±25 m. Device-reported.",
    );
  });

  it("omits the accuracy when the device did not report one", () => {
    expect(formatCheckIn({ accuracyM: null, distanceFromSiteM: 140, late: false })).toBe(
      "Checked in, 140 m from site. Device-reported.",
    );
  });

  it("says when the device clock was late", () => {
    expect(formatCheckIn({ accuracyM: 25, distanceFromSiteM: 0, late: true })).toBe(
      "Checked in ±25 m, 0 m from site. Device-reported. The device time was more than 10 minutes old.",
    );
  });
});

describe("osmHref", () => {
  it("links the point on OpenStreetMap", () => {
    expect(osmHref(30.2672, -97.7431)).toBe(
      "https://www.openstreetmap.org/?mlat=30.2672&mlon=-97.7431#map=17/30.2672/-97.7431",
    );
  });

  it("refuses a coordinate that is not a real position", () => {
    expect(osmHref(Number.NaN, 0)).toBeNull();
    expect(osmHref(91, 0)).toBeNull();
    expect(osmHref(0, 181)).toBeNull();
  });
});

describe("eventSummary", () => {
  it("names a status change in words", () => {
    expect(eventSummary({ kind: "status", fromStatus: "en_route", toStatus: "on_site" })).toBe(
      "Status changed from En route to On site",
    );
  });
});
