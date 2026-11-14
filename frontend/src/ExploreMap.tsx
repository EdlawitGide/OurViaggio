
import { FormEvent, useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "./api";
import { Category, Dest, Place, geocode, kindLabel, nearby, overpassQuery, zoomFor } from "./geo";
import { EMOJI, buildPopup } from "./popup";

type Props = { destination: string; code: string; days: number[]; dayLabel: (day: number) => string; reload: () => Promise<unknown> };
const CATEGORIES: Category[] = ["Hotels", "Restaurants", "Cafés", "Attractions"];
const SLUG: Record<Category, string> = { Hotels: "hotels", Restaurants: "restaurants", "Cafés": "cafes", Attractions: "attractions" };

const poiIcon = (c: Category) => L.divIcon({ html: `<span><i>${EMOJI[c]}</i></span>`, className: `poi-pin poi-${SLUG[c]}`, iconSize: [34, 34], iconAnchor: [17, 42], popupAnchor: [0, -40] });

export default function ExploreMap({ destination, code, days, dayLabel, reload }: Props) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const pin = useRef<L.LayerGroup | null>(null);
  const pins = useRef<Map<string, L.Marker>>(new Map());
  const ticket = useRef(0); // ignore responses from searches that were superseded
  const [query, setQuery] = useState(destination);
  const [candidates, setCandidates] = useState<Dest[]>([]);
  const [current, setCurrent] = useState<Dest | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // Popups are built outside React's render, so they read the latest props through a ref instead of a stale closure.
  const latest = useRef({ code, days, dayLabel, reload, hint: "" });
  latest.current = { code, days, dayLabel, reload, hint: current?.label.split(",")[0] || "" };

  useEffect(() => {
    if (!node.current) return;
    const instance = L.map(node.current).setView([20, 0], 2);
    let failed = false;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    })
      .on("tileerror", () => {
        if (!failed) {
          failed = true;
          setMessage("Map tiles could not be loaded. Check your connection.");
        }
      })
      .on("tileload", () => {
        if (failed) {
          failed = false;
          setMessage("");
        }
      })
      .addTo(instance);

    console.info("[ExploreMap] tile source: OpenStreetMap");
    markers.current = L.layerGroup().addTo(instance);
    pin.current = L.layerGroup().addTo(instance);
    map.current = instance;
    // Leaflet measures its box once; re-measure whenever the layout settles or resizes, otherwise tiles render grey.
    const ro = new ResizeObserver(() => instance.invalidateSize());
    ro.observe(node.current);
    return () => { ro.disconnect(); map.current = null; markers.current = null; pin.current = null; instance.remove(); };
  }, []);

  function show(d: Dest) {
    const m = map.current; if (!m) return;
    setCurrent(d); setPlaces([]); setSelected(null); setCategory(null); setMessage("");
    markers.current?.clearLayers(); pin.current?.clearLayers(); pins.current.clear();
    L.marker([d.lat, d.lon], { icon: L.divIcon({ html: "📍", className: "dest-pin", iconSize: [28, 28], iconAnchor: [14, 28] }), keyboard: false }).addTo(pin.current!);
    m.setView([d.lat, d.lon], zoomFor(d)); // centre on the point itself, not on the middle of a huge boundary box
  }

  async function locate(value: string) {
    if (!value.trim() || !map.current) return;
    const mine = ++ticket.current;
    setBusy(true); setMessage(""); setCandidates([]);
    try {
      const found = await geocode(value);
      if (mine !== ticket.current) return;
      if (!found.length) { setMessage(`Couldn't find “${value.trim()}”. Try a city and country, like “Lisbon, Portugal”.`); return; }
      setCandidates(found.length > 1 ? found : []);
      show(found[0]);
    } catch (e) { if (mine === ticket.current) setMessage(e instanceof Error ? e.message : "Search failed."); }
    finally { if (mine === ticket.current) setBusy(false); }
  }

  useEffect(() => { if (destination) void locate(destination); }, [destination]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addToTrip(p: Place, day: number): Promise<boolean> {
    const { code, dayLabel, reload } = latest.current;
    try {
      await api("/trips/" + code + "/activities", code, { method: "POST", body: JSON.stringify({ title: p.name, loc: p.address || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, day }) });
      await reload();
      setMessage(`Added ${p.name} to ${dayLabel(day)}!`);
      return true;
    } catch (e) { setMessage(e instanceof Error ? e.message : "Unable to save activity."); return false; }
  }

  async function findNearby(c: Category) {
    const m = map.current; if (!m) return;
    const mine = ++ticket.current, ctr = m.getCenter(), b = m.getBounds();
    setBusy(true); setMessage(""); setCategory(c); setPlaces([]); setSelected(null); markers.current?.clearLayers(); pins.current.clear();
    try {
      const results = await nearby(c, overpassQuery(c, ctr, (b.getNorth() - b.getSouth()) / 2, (b.getEast() - b.getWest()) / 2), ctr);
      if (mine !== ticket.current) return;
      setPlaces(results);
      for (const p of results) {
        const mk = L.marker([p.lat, p.lon], { icon: poiIcon(c), title: p.name }).addTo(markers.current!);
        mk.bindPopup(buildPopup({ place: p, hint: latest.current.hint, days: latest.current.days, dayLabel: latest.current.dayLabel, onAdd: addToTrip }), { maxWidth: 320, minWidth: 250 });
        mk.on("click", () => setSelected(p.id));
        pins.current.set(p.id, mk);
      }
      if (results.length) {
        m.fitBounds(L.latLngBounds(results.map(p => [p.lat, p.lon] as [number, number])), { padding: [50, 50], maxZoom: 16 });
        setMessage(`Found ${results.length} ${c.toLowerCase()}. Tap a pin for details, hours, website and directions.`);
      } else setMessage(`No ${c.toLowerCase()} found in this part of the map. Pan or zoom to another area and try again.`);
    } catch (e) { if (mine === ticket.current) setMessage(e instanceof Error ? e.message : "Nearby search failed."); }
    finally { if (mine === ticket.current) setBusy(false); }
  }

  function choose(p: Place) {
    setSelected(p.id);
    map.current?.setView([p.lat, p.lon], Math.max(map.current.getZoom(), 16));
    pins.current.get(p.id)?.openPopup();
  }

  return <div className="trip-map-page">
    <form className="map-search" onSubmit={(e: FormEvent) => { e.preventDefault(); void locate(query); }}>
      <input aria-label="Search destination" value={query} onChange={e => setQuery(e.target.value)} placeholder="City, Country (e.g. Rome, Italy)" />
      <button className="pri" disabled={busy}>Search destination</button>
    </form>
    {current && <p className="sub map-current">📍 Showing <strong>{current.label}</strong></p>}
    {candidates.length > 1 && <div className="map-candidates" aria-label="Other matches">
      <small>Not the right place?</small>
      {candidates.map((c, i) => <button key={i} type="button" className={c === current ? "chosen" : ""} onClick={() => show(c)} title={c.label}>{c.label}</button>)}
    </div>}
    <div className="map-filters">
      {CATEGORIES.map(c => <button key={c} className={"outline-action" + (category === c ? " active" : "")} type="button" disabled={busy || !current} onClick={() => void findNearby(c)}>
        {EMOJI[c]} {c}{busy && category === c ? "…" : ""}</button>)}
    </div>
    <div className="map-status" role="status" aria-live="polite">{busy ? `Searching${category ? " " + category.toLowerCase() : ""}… this can take a few seconds.` : message}</div>
    <div ref={node} className="trip-explore-map" aria-label="Interactive destination map" />
    <div className="map-place-list">
      {places.map(p => <button key={p.id} className={selected === p.id ? "map-place chosen" : "map-place"} onClick={() => choose(p)}>
        <strong>{p.name}</strong><small>{kindLabel(p)}{p.address ? " · " + p.address : ""}</small>
      </button>)}
    </div>
    <p className="sub">Search by OpenStreetMap Nominatim; places from OpenStreetMap contributors. Listings may be incomplete and this is not live booking availability.</p>
  </div>;
}
