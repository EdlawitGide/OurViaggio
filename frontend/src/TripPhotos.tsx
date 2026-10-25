import { useCallback, useEffect, useState, ChangeEvent } from "react";
import { tok } from "./api";

type Photo = { id: number; filename: string; size: number; by: number; uploaded_at: number };
type Member = { id: number; name: string };
type Props = { code: string; members: Member[] };

export default function TripPhotos({ code, members }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const base = `/api/trips/${encodeURIComponent(code)}/photos`;
  const token = tok(code) || "";
  const headers = { "X-Token": token };
  const load = useCallback(async () => {
    const response = await fetch(base, { headers });
    if (!response.ok) throw new Error(await response.text());
    setPhotos(await response.json());
  }, [base, token]);

  useEffect(() => {
    void load().catch(() => setMessage("Unable to load trip photos."));
    const interval = window.setInterval(() => void load().catch(() => {}), 12000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let made: string[] = [];
    const fetchImages = async () => {
      const results = await Promise.all(photos.map(async (photo) => {
        try {
          const response = await fetch(`${base}/${photo.id}/file`, { headers });
          if (!response.ok) return null;
          const url = URL.createObjectURL(await response.blob());
          made.push(url);
          return [photo.id, url] as const;
        } catch { return null; }
      }));
      if (cancelled) { made.forEach(URL.revokeObjectURL); return; }
      setUrls(Object.fromEntries(results.filter((x): x is readonly [number, string] => x !== null)));
    };
    void fetchImages();
    return () => { cancelled = true; made.forEach(URL.revokeObjectURL); };
  }, [photos, base, token]);

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true); setMessage("");
    let succeeded = 0;
    let lastError = "";
    for (const file of files) {
      if (file.size > 12 * 1024 * 1024) { lastError = `${file.name} exceeds 12 MB.`; continue; }
      const form = new FormData(); form.append("file", file);
      try {
        const response = await fetch(base, { method: "POST", headers, body: form });
        if (!response.ok) throw new Error((await response.json()).detail || "Upload failed.");
        succeeded++;
      } catch (error) { lastError = error instanceof Error ? error.message : "Upload failed."; }
    }
    e.target.value = "";
    try { await load(); } catch { lastError = "Could not refresh gallery."; }
    setMessage(`${succeeded} photo${succeeded === 1 ? "" : "s"} uploaded.${lastError ? ` ${lastError}` : ""}`);
    setBusy(false);
  }

  async function downloadSelected() {
    if (!picked.length) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`${base}/download`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: picked }),
      });
      if (!response.ok) throw new Error((await response.json()).detail || "Download failed.");
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a"); a.href = url; a.download = "tripsync-photos.zip";
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Download failed."); }
    finally { setBusy(false); }
  }

  return <section className="trip-photos-page">
    <div className="trip-photos-toolbar">
      <label className="pri photo-upload-button">＋ Upload photos
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e => void upload(e)} disabled={busy} />
      </label>
      <button type="button" className="outline-action" disabled={busy || !photos.length} onClick={() => setPicked(picked.length === photos.length ? [] : photos.map(p => p.id))}>
        {picked.length === photos.length && photos.length ? "Deselect all" : "Select all"}
      </button>
      <button type="button" className="outline-action" disabled={busy || !picked.length} onClick={() => void downloadSelected()}>
        ↓ Download selected ({picked.length})
      </button>
    </div>
    <p className="sub">Shared with all members of this trip. Upload JPG, PNG or WebP images up to 12 MB each.</p>
    {message && <p className="photo-message" role="status">{message}</p>}
    {busy && <p className="sub">Working…</p>}
    {!photos.length && !busy && <div className="card photo-empty"><strong>No photos yet</strong><p className="sub">Upload the first memory from your trip!</p></div>}
    <div className="trip-photo-grid">{photos.map(photo => <div className={picked.includes(photo.id) ? "trip-photo selected" : "trip-photo"} key={photo.id}>
      <label className="trip-photo-selection"><input type="checkbox" checked={picked.includes(photo.id)} onChange={e => setPicked(old => e.target.checked ? [...old, photo.id] : old.filter(id => id !== photo.id))} aria-label={`Select ${photo.filename}`} /></label>
      {urls[photo.id] ? <img src={urls[photo.id]} alt={photo.filename} loading="lazy" /> : <div className="photo-loading">Loading image…</div>}
      <div className="trip-photo-info"><strong title={photo.filename}>{photo.filename}</strong><small>By {members.find(m => m.id === photo.by)?.name || "Trip member"}</small></div>
    </div>)}</div>
  </section>;
}
