/** Earth mean radius in metres, used for the check-in distance shown on the job. */
const EARTH_M = 6_371_000;

/** Four decimal places is about 11 m of latitude. Check-ins are stored at this precision. */
export function roundCoord(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function haversineMeters(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const lat1 = rad(from.lat);
  const lat2 = rad(to.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** OpenStreetMap link only. No tiles and no other request. */
export function osmUrl(lat: number, lng: number, decimals = 4): string {
  const la = lat.toFixed(decimals);
  const ln = lng.toFixed(decimals);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${ln}#map=18/${la}/${ln}`;
}

export type CheckInView = {
  /** For example "Checked in ±25 m, 145 m from site". */
  summary: string;
  osmUrl: string;
  /** Always true: the point came from the device, not from a map pick. */
  deviceReported: true;
};

/**
 * What the technician and the office see for one check-in.
 * Returns null when the technician checked in without sharing a location.
 */
export function checkInView(input: {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  late: boolean;
  siteLat: number | null;
  siteLng: number | null;
}): CheckInView | null {
  if (input.lat == null || input.lng == null) return null;
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) return null;
  const accuracy =
    input.accuracyM != null && Number.isFinite(input.accuracyM) ? `±${Math.round(input.accuracyM)} m` : null;
  let distance: string | null = null;
  if (
    input.siteLat != null &&
    input.siteLng != null &&
    Number.isFinite(input.siteLat) &&
    Number.isFinite(input.siteLng)
  ) {
    const meters = Math.round(
      haversineMeters({ lat: input.lat, lng: input.lng }, { lat: input.siteLat, lng: input.siteLng }),
    );
    distance = `${meters} m from site`;
  }
  let summary = "Checked in";
  if (accuracy && distance) summary = `Checked in ${accuracy}, ${distance}`;
  else if (accuracy) summary = `Checked in ${accuracy}`;
  else if (distance) summary = `Checked in, ${distance}`;
  if (input.late) summary += ", reported late";
  return { summary, osmUrl: osmUrl(input.lat, input.lng), deviceReported: true };
}
