export const tok = (c: string) => localStorage.getItem("tok:" + c) || "";
export const setTok = (c: string, t: string) => localStorage.setItem("tok:" + c, t);
export async function api<T>(path: string, code?: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch("/api" + path, { ...opts, headers: { "Content-Type": "application/json", ...(code ? { "X-Token": tok(code) } : {}) } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.detail || r.statusText); }
  return r.json();
}
