import { describe, expect, it } from "vitest";
import { checkInView, haversineMeters, osmUrl, roundCoord } from "./check-in";

describe("check-in distance", () => {
  it("rounds to 4 decimal places, about 11 m of latitude", () => {
    expect(roundCoord(30.267249)).toBe(30.2672);
    expect(roundCoord(30.26725)).toBe(30.2673);
    const step = haversineMeters({ lat: 30, lng: 0 }, { lat: 30.0001, lng: 0 });
    expect(step).toBeGreaterThan(10);
    expect(step).toBeLessThan(12);
  });

  it("measures about 111.2 km for one degree of longitude at the equator", () => {
    const meters = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(meters).toBeGreaterThan(111_000);
    expect(meters).toBeLessThan(111_400);
  });

  it("says how far the check-in is from the site and links to OpenStreetMap", () => {
    const view = checkInView({
      lat: 30.0013,
      lng: -97,
      accuracyM: 25,
      late: false,
      siteLat: 30,
      siteLng: -97,
    });
    expect(view?.summary).toBe("Checked in ±25 m, 145 m from site");
    expect(view?.deviceReported).toBe(true);
    expect(view?.osmUrl).toBe("https://www.openstreetmap.org/?mlat=30.0013&mlon=-97.0000#map=18/30.0013/-97.0000");
    expect(view?.osmUrl.startsWith("https://www.openstreetmap.org/")).toBe(true);
  });

  it("omits the distance when the site has no coordinates, and skips a check-in with no point", () => {
    expect(
      checkInView({ lat: 30.0013, lng: -97, accuracyM: 25, late: true, siteLat: null, siteLng: null })?.summary,
    ).toBe("Checked in ±25 m, reported late");
    expect(checkInView({ lat: null, lng: null, accuracyM: null, late: false, siteLat: 30, siteLng: -97 })).toBeNull();
  });

  it("builds a site link at the typed precision", () => {
    expect(osmUrl(30.26721, -97.74306, 5)).toContain("mlat=30.26721");
  });
});
