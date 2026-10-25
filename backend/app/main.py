import os, json, secrets, string, time, io, zipfile, uuid
import httpx
from fastapi import FastAPI, HTTPException, Header, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, ForeignKey, JSON, String, UniqueConstraint, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from fastapi.responses import Response
from pathlib import Path
from PIL import Image, UnidentifiedImageError

URL = os.getenv("DATABASE_URL", "sqlite:///./trips.db")
engine = create_engine(URL, connect_args={"check_same_thread": False} if URL.startswith("sqlite") else {})
Session = sessionmaker(engine, expire_on_commit=False)
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")

class Base(DeclarativeBase): pass
class Trip(Base):
    __tablename__ = "trips"
    id: Mapped[int] = mapped_column(primary_key=True); code: Mapped[str] = mapped_column(String(12), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80)); dest: Mapped[str] = mapped_column(String(80), default="")
    start: Mapped[str] = mapped_column(String(10), default=""); days: Mapped[int] = mapped_column(default=3)
class Member(Base):
    __tablename__ = "members"
    id: Mapped[int] = mapped_column(primary_key=True); trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id"), index=True)
    name: Mapped[str] = mapped_column(String(40)); token: Mapped[str] = mapped_column(String(40), unique=True)
class Activity(Base):
    __tablename__ = "activities"
    id: Mapped[int] = mapped_column(primary_key=True); trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id"), index=True)
    day: Mapped[int]; time: Mapped[str] = mapped_column(String(5), default=""); title: Mapped[str] = mapped_column(String(100))
    loc: Mapped[str] = mapped_column(String(100), default=""); by: Mapped[int]
class Poll(Base):
    __tablename__ = "polls"
    id: Mapped[int] = mapped_column(primary_key=True); trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id"), index=True)
    question: Mapped[str] = mapped_column(String(120)); day: Mapped[int] = mapped_column(default=1); options: Mapped[list] = mapped_column(JSON)
class Vote(Base):
    __tablename__ = "votes"
    __table_args__ = (UniqueConstraint("poll_id", "member_id"),)
    id: Mapped[int] = mapped_column(primary_key=True); poll_id: Mapped[int] = mapped_column(ForeignKey("polls.id"), index=True)
    member_id: Mapped[int]; option: Mapped[int]
class Expense(Base):
    __tablename__ = "expenses"
    id: Mapped[int] = mapped_column(primary_key=True); trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id"), index=True)
    desc: Mapped[str] = mapped_column(String(100)); cat: Mapped[str] = mapped_column(String(30), default="Other")
    amount: Mapped[float]; paid_by: Mapped[int]; shares: Mapped[dict] = mapped_column(JSON); ts: Mapped[float]

class Photo(Base):
    __tablename__ = "photos"
    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id"), index=True)
    member_id: Mapped[int]
    filename: Mapped[str] = mapped_column(String(180))
    stored_name: Mapped[str] = mapped_column(String(60), unique=True)
    mime: Mapped[str] = mapped_column(String(30))
    size: Mapped[int]
    uploaded_at: Mapped[float]

PHOTO_ROOT = Path(os.getenv("PHOTO_ROOT", "/srv/uploads"))
PHOTO_ROOT.mkdir(parents=True, exist_ok=True)
MAX_PHOTO_BYTES = 12 * 1024 * 1024

app = FastAPI(title="TripSync")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
@app.on_event("startup")
def _init(): Base.metadata.create_all(engine)

class NewTrip(BaseModel): name: str; dest: str = ""; start: str = ""; days: int = 3; creator: str
class Join(BaseModel): name: str
class ActIn(BaseModel): day: int = 1; time: str = ""; title: str; loc: str = ""
class PollIn(BaseModel): question: str; day: int = 1; options: list[str]
class VoteIn(BaseModel): option: int
class ExpIn(BaseModel): desc: str; cat: str = "Other"; amount: float; paid_by: int; shares: dict[int, float]
class Suggest(BaseModel): wish: str = ""

def trip_of(s, code):
    t = s.scalar(select(Trip).where(Trip.code == code))
    if not t: raise HTTPException(404, "Trip not found")
    return t
def member_of(s, t, token):
    m = s.scalar(select(Member).where(Member.trip_id == t.id, Member.token == token))
    if not m: raise HTTPException(401, "Join this trip first")
    return m
def new_member(s, t, name):
    m = Member(trip_id=t.id, name=name.strip()[:40] or "Guest", token=secrets.token_urlsafe(24)); s.add(m); s.commit(); return m

def settle(bal):
    cr = sorted([[k, round(v, 2)] for k, v in bal.items() if v > .005], key=lambda x: -x[1])
    de = sorted([[k, round(-v, 2)] for k, v in bal.items() if v < -.005], key=lambda x: -x[1]); out = []
    while cr and de:
        a = min(cr[0][1], de[0][1]); out.append({"from": de[0][0], "to": cr[0][0], "amount": round(a, 2)})
        cr[0][1] -= a; de[0][1] -= a
        cr = [c for c in cr if c[1] > .005]; de = [d for d in de if d[1] > .005]
        cr.sort(key=lambda x: -x[1]); de.sort(key=lambda x: -x[1])
    return out

def state(s, t, token):
    ms = s.scalars(select(Member).where(Member.trip_id == t.id)).all(); me = next((m.id for m in ms if m.token == token), None)
    polls = []
    for p in s.scalars(select(Poll).where(Poll.trip_id == t.id).order_by(Poll.id.desc())):
        counts, mine = [0] * len(p.options), None
        for v in s.scalars(select(Vote).where(Vote.poll_id == p.id)):
            if v.option < len(counts): counts[v.option] += 1
            if v.member_id == me: mine = v.option
        polls.append({"id": p.id, "question": p.question, "day": p.day, "options": p.options, "counts": counts, "mine": mine})
    es = s.scalars(select(Expense).where(Expense.trip_id == t.id).order_by(Expense.ts.desc())).all()
    bal = {m.id: 0.0 for m in ms}
    for e in es:
        bal[e.paid_by] = bal.get(e.paid_by, 0) + e.amount
        for k, a in e.shares.items(): bal[int(k)] = bal.get(int(k), 0) - a
    return {"trip": {"code": t.code, "name": t.name, "dest": t.dest, "start": t.start, "days": t.days}, "me": me,
            "members": [{"id": m.id, "name": m.name} for m in ms],
            "activities": [{"id": a.id, "day": a.day, "time": a.time, "title": a.title, "loc": a.loc, "by": a.by}
                           for a in s.scalars(select(Activity).where(Activity.trip_id == t.id))],
            "polls": polls, "balances": bal, "settle": settle(bal),
            "expenses": [{"id": e.id, "desc": e.desc, "cat": e.cat, "amount": e.amount, "paid_by": e.paid_by, "shares": e.shares} for e in es]}

class PhotoDownload(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=100)

@app.get("/api/trips/{code}/photos")
def list_photos(code: str, x_token: str = Header("")):
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token)
        photos = s.scalars(select(Photo).where(Photo.trip_id == t.id).order_by(Photo.uploaded_at.desc())).all()
        return [{"id": p.id, "filename": p.filename, "size": p.size, "by": p.member_id, "uploaded_at": p.uploaded_at} for p in photos]

@app.post("/api/trips/{code}/photos", status_code=201)
async def upload_photo(code: str, file: UploadFile = File(...), x_token: str = Header("")):
    # Validate membership before reading or writing photo bytes.
    with Session() as s:
        t = trip_of(s, code); member = member_of(s, t, x_token)
        data = await file.read(MAX_PHOTO_BYTES + 1)
        if len(data) > MAX_PHOTO_BYTES: raise HTTPException(413, "Photo exceeds 12 MB")
        if not data: raise HTTPException(400, "Empty photo")
        try:
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in ("JPEG", "PNG", "WEBP"):
                    raise HTTPException(400, "Only JPG, PNG, and WebP are supported")
                if image.width * image.height > 40_000_000:
                    raise HTTPException(400, "Image dimensions are too large")
                mime = {"JPEG":"image/jpeg", "PNG":"image/png", "WEBP":"image/webp"}[image.format]
                ext = {"JPEG":"jpg", "PNG":"png", "WEBP":"webp"}[image.format]
                # Re-encode to strip metadata like GPS/EXIF from shared uploads.
                out = io.BytesIO()
                cleaned = image.convert("RGB") if image.format == "JPEG" else image.copy()
                if image.format == "JPEG": cleaned.save(out, format="JPEG", quality=88)
                elif image.format == "PNG": cleaned.save(out, format="PNG")
                else: cleaned.save(out, format="WEBP", quality=88)
                cleaned.close()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
            raise HTTPException(400, "Invalid or unsupported photo") from exc
        stored_name = f"{uuid.uuid4().hex}.{ext}"
        target = PHOTO_ROOT / stored_name
        target.write_bytes(out.getvalue())
        safe_name = Path(file.filename or f"photo.{ext}").name[:180] or f"photo.{ext}"
        p = Photo(trip_id=t.id, member_id=member.id, filename=safe_name, stored_name=stored_name,
                  mime=mime, size=target.stat().st_size, uploaded_at=time.time())
        try:
            s.add(p); s.commit(); s.refresh(p)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return {"id": p.id, "ok": True}

@app.get("/api/trips/{code}/photos/{photo_id}/file")
def get_photo_file(code: str, photo_id: int, x_token: str = Header("")):
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token)
        p = s.get(Photo, photo_id)
        if not p or p.trip_id != t.id: raise HTTPException(404, "Photo not found")
        target = PHOTO_ROOT / p.stored_name
        if not target.is_file(): raise HTTPException(404, "Photo file missing")
        return Response(content=target.read_bytes(), media_type=p.mime,
                        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})

@app.post("/api/trips/{code}/photos/download")
def download_photos(code: str, body: PhotoDownload, x_token: str = Header("")):
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token)
        selected = s.scalars(select(Photo).where(Photo.trip_id == t.id, Photo.id.in_(body.ids))).all()
        if len(selected) != len(set(body.ids)): raise HTTPException(404, "One or more photos not found")
        memory = io.BytesIO()
        with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as bundle:
            for p in selected:
                path = PHOTO_ROOT / p.stored_name
                if not path.is_file(): raise HTTPException(404, "A photo file is missing")
                bundle.write(path, arcname=f"{p.id}_{Path(p.filename).name}")
        return Response(content=memory.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition": 'attachment; filename="tripsync-photos.zip"', "Cache-Control": "private, no-store"})

@app.post("/api/trips")
def create_trip(b: NewTrip):
    with Session() as s:
        code = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(7))
        t = Trip(code=code, name=b.name[:80], dest=b.dest[:80], start=b.start, days=max(1, min(b.days, 30))); s.add(t); s.commit()
        return {"code": code, "token": new_member(s, t, b.creator).token}
@app.post("/api/trips/{code}/join")
def join(code: str, b: Join):
    with Session() as s:
        t = trip_of(s, code); m = new_member(s, t, b.name); return {"token": m.token, "id": m.id}
@app.get("/api/trips/{code}")
def get_trip(code: str, x_token: str = Header("")):
    with Session() as s: return state(s, trip_of(s, code), x_token)
@app.post("/api/trips/{code}/activities")
def add_act(code: str, b: ActIn, x_token: str = Header("")):
    with Session() as s:
        t = trip_of(s, code); m = member_of(s, t, x_token)
        s.add(Activity(trip_id=t.id, day=b.day, time=b.time, title=b.title[:100], loc=b.loc[:100], by=m.id)); s.commit(); return {"ok": True}
@app.delete("/api/trips/{code}/activities/{aid}")
def del_act(code: str, aid: int, x_token: str = Header("")):
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token); a = s.get(Activity, aid)
        if a and a.trip_id == t.id: s.delete(a); s.commit()
        return {"ok": True}
@app.post("/api/trips/{code}/polls")
def add_poll(code: str, b: PollIn, x_token: str = Header("")):
    opts = [o.strip()[:80] for o in b.options if o.strip()]
    if len(opts) < 2: raise HTTPException(400, "A poll needs at least two options")
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token)
        s.add(Poll(trip_id=t.id, question=b.question[:120], day=b.day, options=opts)); s.commit(); return {"ok": True}
@app.post("/api/trips/{code}/polls/{pid}/vote")
def vote(code: str, pid: int, b: VoteIn, x_token: str = Header("")):
    with Session() as s:
        t = trip_of(s, code); m = member_of(s, t, x_token); p = s.get(Poll, pid)
        if not p or p.trip_id != t.id or not 0 <= b.option < len(p.options): raise HTTPException(400, "Bad vote")
        v = s.scalar(select(Vote).where(Vote.poll_id == pid, Vote.member_id == m.id))
        if v and v.option == b.option: s.delete(v)
        elif v: v.option = b.option
        else: s.add(Vote(poll_id=pid, member_id=m.id, option=b.option))
        s.commit(); return {"ok": True}
@app.post("/api/trips/{code}/expenses")
def add_exp(code: str, b: ExpIn, x_token: str = Header("")):
    if b.amount <= 0 or not b.shares or abs(sum(b.shares.values()) - b.amount) > .02: raise HTTPException(400, "Shares must add up to the amount")
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token)
        s.add(Expense(trip_id=t.id, desc=b.desc[:100], cat=b.cat[:30], amount=b.amount, paid_by=b.paid_by,
                      shares={str(k): v for k, v in b.shares.items()}, ts=time.time())); s.commit(); return {"ok": True}
@app.delete("/api/trips/{code}/expenses/{eid}")
def del_exp(code: str, eid: int, x_token: str = Header("")):
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token); e = s.get(Expense, eid)
        if e and e.trip_id == t.id: s.delete(e); s.commit()
        return {"ok": True}

GEM = "https://generativelanguage.googleapis.com/v1beta"

def _gemini(prompt: str, key: str) -> str:
    """Google Gemini (free tier, no billing needed). Key goes in a header, never the URL."""
    def call(m):
        return httpx.post(f"{GEM}/models/{m}:generateContent", timeout=60, headers={"x-goog-api-key": key},
                          json={"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseMimeType": "application/json"}})
    r = call(os.getenv("GEMINI_MODEL", "gemini-2.5-flash"))
    if r.status_code == 404:  # model name retired: fall back to whichever Flash model is currently offered
        ms = httpx.get(f"{GEM}/models", headers={"x-goog-api-key": key}, timeout=30).json().get("models", [])
        ok = [m["name"].split("/")[-1] for m in ms if "generateContent" in m.get("supportedGenerationMethods", [])
              and "flash" in m["name"] and not any(x in m["name"] for x in ("image", "tts", "live", "audio", "thinking"))]
        if ok: r = call(ok[0])
    if r.status_code == 429: raise HTTPException(429, "The free AI limit was reached. Wait a minute and try again.")
    if r.status_code != 200: raise HTTPException(502, "The AI service returned an error. Check your GEMINI_API_KEY.")
    try: return r.json()["candidates"][0]["content"]["parts"][0]["text"]
    except Exception: raise HTTPException(502, "The AI service returned an empty answer, try again")

def _claude(prompt: str, key: str) -> str:
    r = httpx.post("https://api.anthropic.com/v1/messages", timeout=60, headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                   json={"model": MODEL, "max_tokens": 1200, "messages": [{"role": "user", "content": prompt}]})
    if r.status_code != 200: raise HTTPException(502, "The AI service returned an error")
    return r.json()["content"][0]["text"]

@app.post("/api/trips/{code}/suggest")
def suggest(code: str, b: Suggest, x_token: str = Header("")):
    """LLM itinerary ideas grounded in destination, existing plans and poll results. Uses Gemini (free) or Claude."""
    gkey, akey = os.getenv("GEMINI_API_KEY"), os.getenv("ANTHROPIC_API_KEY")
    if not gkey and not akey: raise HTTPException(503, "AI ideas are off. Set GEMINI_API_KEY (free from Google AI Studio) on the API server.")
    with Session() as s:
        t = trip_of(s, code); member_of(s, t, x_token); st = state(s, t, x_token)
    wins = [f'{p["question"]}: {p["options"][p["counts"].index(max(p["counts"]))]}' for p in st["polls"] if max(p["counts"] or [0]) > 0]
    have = [f'day {a["day"]} {a["time"]} {a["title"]}' for a in st["activities"]]
    prompt = (f"Group trip to {t.dest or t.name}, {t.days} days, {len(st['members'])} friends. Already planned: {have or 'nothing'}. "
              f"Group poll winners: {wins or 'none yet'}. Their wishes: {b.wish[:300] or 'none'}. "
              "Suggest 6 activities that fit the days and avoid duplicates. Reply with ONLY a JSON array of "
              '{"day":int,"time":"HH:MM","title":str,"loc":str}.')
    txt = _gemini(prompt, gkey) if gkey else _claude(prompt, akey)
    try: items = json.loads(txt[txt.index("["): txt.rindex("]") + 1])
    except Exception: raise HTTPException(502, "Could not read the AI response, try again")
    return {"ideas": [{"day": max(1, min(int(i.get("day", 1)), t.days)), "time": str(i.get("time", ""))[:5],
                       "title": str(i.get("title", ""))[:100], "loc": str(i.get("loc", ""))[:100]} for i in items[:8] if i.get("title")]}
