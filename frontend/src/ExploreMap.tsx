import { MaptilerLayer, MapStyle, Language } from "@maptiler/leaflet-maptilersdk";
import { FormEvent, useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "./api";

type Place = { id: string; name: string; lat: number; lon: number; category: string; address: string };
type Props = { destination: string; code: string; days: number[]; dayLabel: (day: number) => string; reload: () => Promise<unknown> };

export default function ExploreMap({ destination, code, days, dayLabel, reload }: Props) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [query, setQuery] = useState(destination);
  const [places, setPlaces] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [day, setDay] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!node.current) return;
    const instance = L.map(node.current).setView([20, 0], 2);
    new MaptilerLayer({
      apiKey: import.meta.env.VITE_MAPTILER_KEY,
      style: MapStyle.STREETS,
      language: Language.ENGLISH,
    }).addTo(instance);
    const markers = L.layerGroup().addTo(instance);
    map.current = instance;
    layer.current = markers;
    return () => { map.current = null; layer.current = null; instance.remove(); };
  }, []);

  async function locate(value: string) {
    if (!value.trim() || !map.current) return;
    setBusy(true); setMessage(""); setPlaces([]); setSelected(null); layer.current?.clearLayers();
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(value));
      if (!r.ok) throw new Error("Destination lookup unavailable.");
      const results = await r.json();
      if (!results.length) throw new Error("Destination not found. Try a city and country.");
      map.current.setView([Number(results[0].lat), Number(results[0].lon)], 13);
    } catch (e) { setMessage(e instanceof Error ? e.message : "Search failed."); }
    finally { setBusy(false); }
  }

  useEffect(() => { if (destination) void locate(destination); }, [destination]);

  async function nearby(category: "Hotels" | "Restaurants" | "Cafés" | "Attractions") {
    if (!map.current) return;
    const { lat, lng } = map.current.getCenter();
    const tags: Record<string, string> = {
      Hotels: '["tourism"~"^(hotel|hostel|guest_house|motel)$"]',
      Restaurants: '["amenity"="restaurant"]',
      "Cafés": '["amenity"="cafe"]',
      Attractions: '["tourism"~"^(attraction|museum|gallery|viewpoint)$"]',
    };
    const q = `[out:json][timeout:25];nwr(around:3000,${lat},${lng})${tags[category]};out center 80;`;
    setBusy(true); setMessage(""); setPlaces([]); setSelected(null); layer.current?.clearLayers();
    try {
      const r = await fetch("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q));
      if (!r.ok) throw new Error("Nearby search is busy. Please try again later.");
      const data = await r.json();
      const results: Place[] = (data.elements || []).map((p: any) => ({
        id: `${p.type}-${p.id}`,
        name: p.tags?.name || `${category.slice(0, -1)} (unnamed)`,
        lat: Number(p.lat ?? p.center?.lat),
        lon: Number(p.lon ?? p.center?.lon),
        category,
        address: [p.tags?.["addr:street"], p.tags?.["addr:housenumber"]].filter(Boolean).join(" "),
      })).filter((p: Place) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      setPlaces(results);
      for (const p of results) {
        const dot = L.circleMarker([p.lat, p.lon], { radius: 7, color: "#254bbd", weight: 2, fillColor: "#ff985c", fillOpacity: .92 }).addTo(layer.current!);
        const label = document.createElement("span"); label.textContent = p.name;
        dot.bindPopup(label);
        dot.on("click", () => setSelected(p));
      }
      if (!results.length) setMessage("No mapped places found in this area. Try another category or destination.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Nearby search failed."); }
    finally { setBusy(false); }
  }

  function choose(p: Place) {
    setSelected(p);
    map.current?.setView([p.lat, p.lon], Math.max(map.current.getZoom(), 15));
  }

  async function save() {
    if (!selected) return;
    setBusy(true); setMessage("");
    try {
      await api("/trips/" + code + "/activities", code, {
        method: "POST",
        body: JSON.stringify({ title: selected.name, loc: selected.address || `${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}`, day }),
      });
      await reload();
      setMessage(`Added ${selected.name} to ${dayLabel(day)}!`);
    } catch (e) { setMessage(e instanceof Error ? e.message : "Unable to save activity."); }
    finally { setBusy(false); }
  }

  return <div className="trip-map-page">
    <form className="map-search" onSubmit={(e: FormEvent) => { e.preventDefault(); void locate(query); }}>
      <input aria-label="Search destination" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search city or destination" />
      <button className="pri" disabled={busy}>Search destination</button>
    </form>
    <div className="map-filters">
      {(["Hotels", "Restaurants", "Cafés", "Attractions"] as const).map(c =>
        <button key={c} className="outline-action" type="button" disabled={busy} onClick={() => void nearby(c)}>{c}</button>
      )}
    </div>
    <div ref={node} className="trip-explore-map" aria-label="Interactive destination map" />
    {message && <p role="status" className="map-message">{message}</p>}
    {busy && <p className="sub">Loading places…</p>}
    <div className="map-place-list">
      {places.map(p => <button key={p.id} className={selected?.id === p.id ? "map-place chosen" : "map-place"} onClick={() => choose(p)}>
        <strong>{p.name}</strong><small>{p.category}{p.address ? " · " + p.address : ""}</small>
      </button>)}
    </div>
    {selected && <section className="card map-selection">
      <h3>{selected.name}</h3><p className="sub">{selected.category}{selected.address ? " · " + selected.address : ""}</p>
      <label>Add to trip day <select value={day} onChange={e => setDay(Number(e.target.value))}>
        {days.map(d => <option value={d} key={d}>{dayLabel(d)}</option>)}
      </select></label>
      <button className="pri" type="button" disabled={busy} onClick={() => void save()}>＋ Add to itinerary</button>
    </section>}
    <p className="sub">Places are from OpenStreetMap contributors. Listings may be incomplete; this is not live booking availability.</p>
  </div>;
}
