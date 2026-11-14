// Builds the info card shown when a pin is clicked. Pure DOM, no React/Leaflet, so it can be tested on its own.
import { Category, Place, details, directionsUrl, googleMapsUrl, kindLabel, osmUrl, websiteOf } from "./geo";

export const EMOJI: Record<Category, string> = { Hotels: "🏨", Restaurants: "🍽️", "Cafés": "☕", Attractions: "🏛️" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; // textContent only: OSM names/tags are user-edited
}
function link(text: string, href: string, cls = "") {
  const a = el("a", cls, text); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; return a;
}

export type PopupOptions = { place: Place; hint: string; days: number[]; dayLabel: (d: number) => string; onAdd: (place: Place, day: number) => Promise<boolean> };

export function buildPopup({ place: p, hint, days, dayLabel, onAdd }: PopupOptions): HTMLElement {
  const root = el("div", "poi-popup");
  root.append(el("h4", "", p.name), el("div", "poi-sub", `${EMOJI[p.category]} ${kindLabel(p)}`));
  for (const d of details(p)) {
    const row = el("div", "poi-row"); row.append(el("span", "poi-ico", d.icon));
    const val = d.href ? link(d.value, d.href) : el("span", "", d.value);
    val.title = d.label; row.append(val); root.append(row);
  }
  const actions = el("div", "poi-actions"), site = websiteOf(p);
  if (site) actions.append(link("Visit website", site, "poi-btn primary"));
  actions.append(link("Google Maps", googleMapsUrl(p, hint), "poi-btn"), link("Directions", directionsUrl(p), "poi-btn"), link("OpenStreetMap", osmUrl(p), "poi-btn"));
  root.append(actions);
  const add = el("div", "poi-add"), sel = el("select");
  days.forEach(d => { const o = el("option", "", dayLabel(d)); o.value = String(d); sel.append(o); });
  const btn = el("button", "poi-btn primary", "＋ Add to itinerary"); btn.type = "button";
  btn.onclick = async () => { btn.disabled = true; const ok = await onAdd(p, Number(sel.value)); btn.textContent = ok ? "Added ✓" : "Try again"; btn.disabled = ok; };
  add.append(sel, btn); root.append(add);
  return root;
}
