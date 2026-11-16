import { buttonSecondary } from "@/components/ui/styles";
import { osmHref } from "@/lib/field-format";

/** A link only. The page never loads map tiles or calls a geocoder. */
export function OsmLink({ lat, lng }: { lat: number; lng: number }) {
  const href = osmHref(lat, lng);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${buttonSecondary} h-auto w-full whitespace-normal sm:w-auto`}>
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        OpenStreetMap ({lat}, {lng})
      </span>
      <span aria-hidden>↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
