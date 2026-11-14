// Pure data helpers for the Explore Map (no Leaflet/React), so they can be tested in isolation.

export type Dest = { label: string; lat: number; lon: number; bbox?: [number, number, number, number] }; // south, west, north, east
export type Category = "Hotels" | "Restaurants" | "Cafés" | "Attractions";
export type Place = { id: string; osm: string; name: string; lat: number; lon: number; category: Category; address: string; tags: Record<string, string> };
export type Detail = { icon: string; label: string; value: string; href?: string };

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const PHOTON = "https://photon.komoot.io/api/";
export const OVERPASS_MIRRORS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
export const TAGS: Record<Category, string> = {
  Hotels: '["tourism"~"^(hotel|hostel|guest_house|motel|apartment)$"]',
  Restaurants: '["amenity"="restaurant"]',
  "Cafés": '["amenity"="cafe"]',
  Attractions: '["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium)$"]',
};
const SINGULAR: Record<Category, string> = { Hotels: "Hotel", Restaurants: "Restaurant", "Cafés": "Café", Attractions: "Attraction" };

async function getJson(url: string, init: RequestInit = {}, ms = 15000, outer?: AbortSignal): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  outer?.addEventListener("abort", () => ctl.abort());
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const num = (v: unknown) => Number(v);
const finite = (...n: number[]) => n.every(Number.isFinite);
const CITYISH = ["city", "municipality", "town", "village"];

async function viaNominatim(q: string): Promise<Dest[]> {
  const rows: any[] = await getJson(`${NOMINATIM}?format=jsonv2&limit=5&accept-language=en&q=${encodeURIComponent(q)}`);
  // "Rome" often returns the municipal boundary first ("Roma Capitale"), whose centroid can be miles from downtown.
  // Prefer the actual city point sitting inside that boundary so the map opens on the city centre.
  const first = rows[0];
  if (first && first.category === "boundary" && CITYISH.includes(first.addresstype)) {
    const i = rows.findIndex(r => r.category === "place" && CITYISH.includes(r.type) && Math.abs(num(r.lat) - num(first.lat)) < .5 && Math.abs(num(r.lon) - num(first.lon)) < .5);
    if (i > 0) rows.unshift(...rows.splice(i, 1));
  }
  return rows.map(r => {
    const b = r.boundingbox?.map(num); // Nominatim order: south, north, west, east
    return { label: String(r.display_name), lat: num(r.lat), lon: num(r.lon), bbox: b && finite(...b) ? [b[0], b[2], b[1], b[3]] as Dest["bbox"] : undefined };
  }).filter(d => finite(d.lat, d.lon));
}

async function viaPhoton(q: string): Promise<Dest[]> {
  const j = await getJson(`${PHOTON}?lang=en&limit=5&q=${encodeURIComponent(q)}`);
  return ((j.features || []) as any[]).map(f => {
    const p = f.properties || {}, [lon, lat] = f.geometry?.coordinates || [];
    const e = p.extent?.map(num); // Photon order: minLon, maxLat, maxLon, minLat
    return { label: [p.name, p.state, p.country].filter(Boolean).join(", "), lat: num(lat), lon: num(lon),
             bbox: e && finite(...e) ? [e[3], e[0], e[1], e[2]] as Dest["bbox"] : undefined };
  }).filter(d => d.label && finite(d.lat, d.lon));
}

/** Geocode "City, Country". Tries Nominatim, then Photon if Nominatim fails or finds nothing. */
export async function geocode(query: string): Promise<Dest[]> {
  const q = query.trim();
  if (!q) return [];
  let hits: Dest[] = [];
  try { hits = await viaNominatim(q); } catch { /* fall through to Photon */ }
  if (hits.length) return hits;
  try { return await viaPhoton(q); } catch { throw new Error("Search service is unreachable. Check your connection and try again."); }
}

/** Zoom level for a result: a street gets close, a city gets a city view, a country a wide one. Never "whole municipality". */
export function zoomFor(d: Dest): number {
  if (!d.bbox) return 13;
  const span = Math.max(d.bbox[2] - d.bbox[0], d.bbox[3] - d.bbox[1]);
  return span < .01 ? 17 : span < .03 ? 16 : span < .12 ? 14 : span < .4 ? 13 : span < 1.5 ? 10 : span < 5 ? 7 : 5;
}

/** Overpass query for the visible map box, capped (~6 km x 7 km) so it stays fast in dense cities. */
export function overpassQuery(category: Category, center: { lat: number; lng: number }, halfLat: number, halfLon: number) {
  const dLat = Math.min(halfLat, 0.03), dLon = Math.min(halfLon, 0.045);
  const bbox = [center.lat - dLat, center.lng - dLon, center.lat + dLat, center.lng + dLon].map(v => v.toFixed(5)).join(",");
  return `[out:json][timeout:15];nwr${TAGS[category]}(${bbox});out center 50;`;
}

function firstSuccess<T>(ps: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => { let fails = 0; ps.forEach(p => p.then(resolve, () => { if (++fails === ps.length) reject(new Error("all failed")); })); });
}

const cache = new Map<string, { t: number; v: Place[] }>();
export const clearCache = () => cache.clear();

/** Fetch places near `center`. Both Overpass mirrors are asked at once and the first good answer wins. Results are cached 5 min. */

export async function nearby(
  category: Category,
  query: string,
  center: { lat: number; lng: number }
): Promise<Place[]> {
  const apiKey = import.meta.env.VITE_GEOAPIFY_API_KEY;

  if (!apiKey) {
    throw new Error("Geoapify API key is missing.");
  }

  const categories: Record<Category, string> = {
    Hotels: "accommodation",
    Restaurants: "catering.restaurant",
    "Cafés": "catering.cafe",
    Attractions: "tourism.attraction,tourism.sights,entertainment.museum",
  };

  const key = `geoapify|${category}|${query}|${center.lat}|${center.lng}`;
  const hit = cache.get(key);

  if (hit && Date.now() - hit.t < 5 * 60_000) {
    return hit.v;
  }

  const params = new URLSearchParams({
    categories: categories[category],
    filter: `circle:${center.lng},${center.lat},3500`,
    bias: `proximity:${center.lng},${center.lat}`,
    limit: "60",
    apiKey,
  });

  const url = `https://api.geoapify.com/v2/places?${params}`;

  let data: any;

  try {
    data = await getJson(url, {}, 15000);
  } catch (error) {
    console.error("Geoapify error:", error);
    throw new Error("Unable to load places. Please try again.");
  }

  if (!Array.isArray(data?.features)) {
    throw new Error("Invalid Geoapify response.");
  }

  const seen = new Set<string>();

  const places: Place[] = data.features
    .map((feature: any) => {
      const p = feature.properties || {};
      const raw = p.datasource?.raw || {};
      const osmType = String(raw.osm_type || "").toLowerCase();
      const type = ({
        n: "node",
        w: "way",
        r: "relation",
        node: "node",
        way: "way",
        relation: "relation",
      } as Record<string, string>)[osmType];

      const osm = type && raw.osm_id
        ? `${type}/${raw.osm_id}`
        : "";

      const tags: Record<string, string> = {
        ...raw,
        "addr:street": p.street || raw["addr:street"] || "",
        "addr:housenumber": p.housenumber || raw["addr:housenumber"] || "",
        "addr:city": p.city || raw["addr:city"] || "",
        "addr:postcode": p.postcode || raw["addr:postcode"] || "",
      };

      const lat = Number(p.lat ?? feature.geometry?.coordinates?.[1]);
      const lon = Number(p.lon ?? feature.geometry?.coordinates?.[0]);

      return {
        id: String(p.place_id || osm || `${lat},${lon}`),
        osm,
        name: String(p.name || raw.name || ""),
        lat,
        lon,
        category,
        address: String(p.formatted || p.address_line2 || ""),
        tags,
      } as Place;
    })
    .filter((p: Place) => {
      if (!p.name || !finite(p.lat, p.lon) || seen.has(p.id)) {
        return false;
      }
      seen.add(p.id);
      return true;
    });

  cache.set(key, { t: Date.now(), v: places });

  return places;
}

// ---------- place details, shown in the pin's popup ----------

/** Accepts only real http(s) links. Bare domains get https://. Anything else (javascript:, data:, junk) is dropped. */
export function safeUrl(raw?: string): string | null {
  const v = (raw || "").split(";")[0].trim();
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : /^[\w-]+(\.[\w-]+)+(\/|$|\?|#|:)/.test(v) ? "https://" + v : "";
  try { const u = new URL(withScheme); return u.protocol === "http:" || u.protocol === "https:" ? u.href : null; } catch { return null; }
}
export function safeTel(raw?: string): string | null {
  const v = (raw || "").split(/[;,]/)[0].replace(/[^\d+]/g, "");
  return v.replace(/\D/g, "").length >= 5 ? v : null;
}
export const websiteOf = (p: Place) => safeUrl(p.tags.website || p.tags["contact:website"] || p.tags.url);
export const osmUrl = (p: Place) => `https://www.openstreetmap.org/${p.osm}`;
export const directionsUrl = (p: Place) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
export const googleMapsUrl = (p: Place, hint = "") => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, hint].filter(Boolean).join(" "))}`;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const humanList = (s: string) => s.split(";").map(x => x.trim().replace(/_/g, " ")).filter(Boolean).map(cap).join(", ");

export function kindLabel(p: Place): string {
  const raw = p.tags.tourism || p.tags.amenity || "";
  return raw && raw !== "yes" ? cap(raw.replace(/_/g, " ")) : SINGULAR[p.category];
}

export function details(p: Place): Detail[] {
  const t = p.tags, out: Detail[] = [];
  const addr = [[t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ")].filter(Boolean).join(", ") || p.address;
  if (addr) out.push({ icon: "📍", label: "Address", value: addr });
  const stars = Number.parseInt(t.stars || "", 10);
  if (stars >= 1 && stars <= 5) out.push({ icon: "⭐", label: "Class", value: "★".repeat(stars) + ` ${stars}-star` });
  if (t.cuisine) out.push({ icon: "🍴", label: "Cuisine", value: humanList(t.cuisine) });
  if (t.opening_hours) out.push({ icon: "🕒", label: "Hours", value: t.opening_hours.replace(/\s*;\s*/g, " · ") });
  const phone = t.phone || t["contact:phone"], tel = safeTel(phone);
  if (phone && tel) out.push({ icon: "📞", label: "Phone", value: phone.split(/[;,]/)[0].trim(), href: "tel:" + tel });
  const mail = (t.email || t["contact:email"] || "").split(";")[0].trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) out.push({ icon: "✉️", label: "Email", value: mail, href: "mailto:" + mail });
  const site = websiteOf(p);
  if (site) out.push({ icon: "🌐", label: "Website", value: new URL(site).hostname.replace(/^www\./, ""), href: site });
  const feats: string[] = [];
  if (t.wheelchair === "yes") feats.push("Wheelchair accessible"); else if (t.wheelchair === "limited") feats.push("Partly wheelchair accessible");
  if (["wlan", "wifi", "yes"].includes(t.internet_access)) feats.push("Wi-Fi");
  if (t.outdoor_seating === "yes") feats.push("Outdoor seating");
  if (t.takeaway === "yes") feats.push("Takeaway");
  if (t.delivery === "yes") feats.push("Delivery");
  if (["yes", "required", "recommended"].includes(t.reservation)) feats.push("Reservations");
  if (t.air_conditioning === "yes") feats.push("Air conditioning");
  if (feats.length) out.push({ icon: "✨", label: "Features", value: feats.join(" · ") });
  if (t.description) out.push({ icon: "ℹ️", label: "About", value: t.description.slice(0, 240) });
  const org = t.brand || t.operator;
  if (org) out.push({ icon: "🏷️", label: "Brand", value: org });
  return out;
}
