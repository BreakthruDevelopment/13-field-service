import { describe, expect, it } from "vitest";
import { checkInView, haversineMeters, roundCoord } from "@/lib/check-in";

describe("check-in coordinates", () => {
  it("rounds half away toward +infinity at four decimal places", () => {
    expect(roundCoord(40.123456)).toBe(40.1235);
    expect(roundCoord(-73.987654)).toBe(-73.9877);
  });

  it("measures zero between the same point", () => {
    expect(haversineMeters({ lat: 40, lng: -73 }, { lat: 40, lng: -73 })).toBe(0);
  });

  it("describes a device check-in and omits a missing point", () => {
    const view = checkInView({
      lat: 40.1235,
      lng: -73.9877,
      accuracyM: 25,
      late: false,
      siteLat: 40.1235,
      siteLng: -73.9877,
    });
    expect(view?.summary).toBe("Checked in ±25 m, 0 m from site");
    expect(view?.deviceReported).toBe(true);
    expect(view?.osmUrl).toContain("mlat=40.1235");
    expect(checkInView({ lat: null, lng: null, accuracyM: null, late: false, siteLat: 1, siteLng: 2 })).toBeNull();
  });
});
