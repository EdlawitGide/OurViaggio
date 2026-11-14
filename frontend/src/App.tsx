import { useCallback, useEffect, useState, FormEvent } from "react";
import { api, setTok, tok } from "./api";
import TripPhotos from "./TripPhotos";
import ExploreMap from "./ExploreMap";
import { supabase } from "./supabase";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = any;
const money = (v: number) => (v < 0 ? "-" : "") + "$" + Math.abs(v).toFixed(2);
const fd = (e: FormEvent) => { e.preventDefault(); return new FormData(e.currentTarget as HTMLFormElement); };

export default function App() {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h.startsWith("#/t/") ? <TripAccess code={h.slice(4)} /> : <Home />;
}


async function accountRequest(path: string, options: RequestInit = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  if (!token) throw new Error("Please log in again");

  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
      Authorization: "Bearer " + token,
    },
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.detail || "Account request failed");
  }

  return result;
}

async function claimMembership(code: string) {
  const token = tok(code);
  if (!token) throw new Error("Trip membership token missing");

  return accountRequest("/trips/" + code + "/claim", {
    method: "POST",
    headers: { "X-Token": token },
  });
}

function TripAccess({ code }: { code: string }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setReady(false);
    setError("");

    (async () => {
      try {
        const membership = await accountRequest(
          "/trips/" + code + "/membership"
        );

        if (active && membership.token) {
          setTok(code, membership.token);
        }
      } catch (e) {
        // A 404 means this account has not linked this trip yet.
        // Keep an existing local membership for explicit claiming.
        if (e instanceof Error &&
            !e.message.includes("No active membership") &&
            active) {
          setError(e.message);
        }
      } finally {
        if (active) setReady(true);
      }
    })();

    return () => { active = false; };
  }, [code]);

  if (!ready) {
    return <main className="home"><p>Opening your trip...</p></main>;
  }

  if (error) {
    return (
      <main className="home">
        <p className="err">{error}</p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>
    );
  }

  return <Trip code={code} />;
}

function Home() {
  const [err, setErr] = useState(""); const [c, setC] = useState("");
  const create = async (e: FormEvent) => {
    const d = fd(e);
    try {
      const r = await api<any>("/trips", undefined, { method: "POST", body: JSON.stringify({ name: d.get("name"), dest: d.get("dest"), start: d.get("start"), days: +(d.get("days") || 3), creator: `${d.get("firstName") || ""} ${d.get("lastName") || ""}`.trim() }) });
      setTok(r.code, r.token); await claimMembership(r.code); location.hash = "#/t/" + r.code;
    } catch (x: any) { setErr(x.message); }
  };
  return (
    <main className="home">
      <h1>Plan the trip together</h1>
      <p className="sub">Create a trip, send the link, and let your friends vote, plan days and split costs.</p>
      <form className="card" onSubmit={create}>
        <label>Trip name<input name="name" required placeholder="Rome with the crew" /></label>
        <label>Destination<input name="dest" placeholder="Rome, Italy" /></label>
        <div className="two"><label>Start date<input name="start" type="date" /></label><label>Days<input name="days" type="number" min={1} max={30} defaultValue={3} /></label></div>
        <div className="two"><label>First name<input name="firstName" required maxLength={40} /></label><label>Last name<input name="lastName" required maxLength={40} /></label></div>
        <button className="pri">Create trip</button>
      </form>
      <form className="card" onSubmit={(e) => { e.preventDefault(); location.hash = "#/t/" + c.trim(); }}>
        <label>Have a trip code?<input value={c} onChange={(e) => setC(e.target.value)} placeholder="e.g. k3j9x2a" /></label>
        <button className="ghost">Open trip</button>
      </form>
      {err && <p className="err">{err}</p>}
    </main>
  );
}

function Trip({ code }: { code: string }) {
  const [s, setS] = useState<S>(null); const [tab, setTab] = useState("plan"); const [err, setErr] = useState(""); const [showActivity, setShowActivity] = useState(false); const [selectedDay, setSelectedDay] = useState(1);
  const load = useCallback(() => api<S>("/trips/" + code, code).then(setS).catch((e) => setErr(e.message)), [code]);
  useEffect(() => { load(); const i = setInterval(load, 4000); return () => clearInterval(i); }, [load]);
  const call = async (path: string, method = "POST", body?: unknown) => {
    try { setErr(""); await api("/trips/" + code + path, code, { method, body: body ? JSON.stringify(body) : undefined }); load(); } catch (e: any) { setErr(e.message); }
  };
  if (err && !s) return <main className="home"><p className="err">{err}</p><a href="#/">Back home</a></main>;
  if (!s) return <main className="home"><p className="sub">Loading trip…</p></main>;
  const nameOf = (id: number) => (id === s.me ? "You" : (s.members.concat(s.former_members || [])).find((m: S) => m.id === id)?.name || "Someone");
  if (s.me == null) return (
    <main className="home"><h1>{s.trip.name}</h1><p className="sub">{s.members.length} friends are in. Add your name to join.</p>
      <form className="card" onSubmit={async (e) => { const d = fd(e); const r = await api<any>("/trips/" + code + "/join", code, { method: "POST", body: JSON.stringify({ name: `${d.get("firstName") || ""} ${d.get("lastName") || ""}`.trim() }) }); setTok(code, r.token); await claimMembership(code); load(); }}>
        <div className="two"><label>First name<input name="firstName" required maxLength={40} /></label><label>Last name<input name="lastName" required maxLength={40} /></label></div><button className="pri">Join workspace</button></form></main>
  );
  const spent = s.expenses.reduce((a: number, e: S) => a + e.amount, 0);
  const dayLabel = (n: number) => { if (!s.trip.start) return "Day " + n; const d = new Date(s.trip.start + "T00:00"); d.setDate(d.getDate() + n - 1); return `Day ${n} · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`; };
  const days = Array.from({ length: Math.max(s.trip.days, ...s.activities.map((a: S) => a.day)) }, (_, i) => i + 1);
  const tabs: [string, string][] = [["plan", "Itinerary"], ["polls", "Polls"], ["money", "Expenses"], ["ai", "AI ideas"]];

  const prettyDate = (n: number) => { if (!s.trip.start) return `Day ${n}`; const d = new Date(s.trip.start + "T00:00"); d.setDate(d.getDate() + n - 1); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
  const monthName = s.trip.start ? new Date(s.trip.start + "T00:00").toLocaleDateString(undefined, {month:"long",year:"numeric"}) : "Your adventure";
  const currentActivities = s.activities.filter((a: S) => a.day === selectedDay).sort((a: S,b: S) => (a.time||"").localeCompare(b.time||""));
  const categories = [{name:"Transport", color:"#12b886",total:s.expenses.filter((e:S)=>e.cat==="Transport").reduce((t:number,e:S)=>t+e.amount,0)}, {name:"Stay",color:"#7757ef",total:s.expenses.filter((e:S)=>e.cat==="Stay").reduce((t:number,e:S)=>t+e.amount,0)},{name:"Other",color:"#ff9c56",total:s.expenses.filter((e:S)=>!['Transport','Stay'].includes(e.cat)).reduce((t:number,e:S)=>t+e.amount,0)}];
  const navItems = [["plan","▦","Overview"],["polls","◉","Group voting"],["money","▤","Expenses"], ["photos","▧","Trip photos"],["ai","✦","AI ideas"],["map","⌖","Explore Map"]];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/"><img className="brand-logo" src="/ourviaggio-icon.png" alt="OurViaggio logo" /><span className="brand-name">OurViaggio</span></a>
        <a href="#/" className="new-trip">New trip <span>＋</span></a>
        <div className="nav-heading">WORKSPACE</div>
        {navItems.map(([key,icon,label])=><button className={'side-item '+(tab===key?'active':'')} key={key} onClick={()=>setTab(key)}><span className="side-icon">{icon}</span>{label}</button>)}
        <div className="sidebar-bottom"><div className="side-help">✧ &nbsp; Your trips, organized.</div><div className="mini-avatar">{(s.members.find((m:S)=>m.id===s.me)?.name||"You").slice(0,1).toUpperCase()}</div><div><strong>{nameOf(s.me)}</strong><small>Trip member</small></div></div>
      </aside>
      <div className="workspace">
        <header className="topbar"><div className="breadcrumbs"><span>My trips</span><span className="crumb-sep">/</span><strong>{s.trip.name}</strong><span className="crumb-down">⌄</span></div><div className="header-actions"><span className="header-status">● &nbsp; Shared workspace</span><button className="top-icon" title="Copy invitation link" onClick={()=>{navigator.clipboard.writeText(location.href);setErr('Invite link copied!')}}>↗</button><span className="mini-avatar">{(s.members.find((m:S)=>m.id===s.me)?.name||"Y").slice(0,1).toUpperCase()}</span></div></header>
        {s.me != null && !s.linked_account && (
          <div className="notice">
            <span>
              Have an existing membership? Link it to your
              OurViaggio account to access this trip anywhere.
            </span>
            <button
              onClick={async () => {
                try {
                  await claimMembership(code);
                  await load();
                  setErr("Membership linked to your account!");
                } catch (e: any) {
                  setErr(e.message);
                }
              }}
            >
              Link my membership
            </button>
          </div>
        )}
        {err && <div className="notice" role="status">{err}<button onClick={()=>setErr('')} aria-label="Dismiss">×</button></div>}
        {tab==='plan' ? <div className="dashboard-grid">
          <main className="dashboard-main">
            <div className="intro-row"><div><p className="eyebrow">YOUR NEXT ADVENTURE</p><h1>Trip overview <span className="sparkle">✳</span></h1><p className="sub">Everything your crew needs, all in one place.</p></div><button className="outline-action" onClick={()=>{navigator.clipboard.writeText(location.href);setErr('Invite link copied!')}}>↗ &nbsp; Invite friends</button></div>
            <section className="destination-banner"><div className="destination-copy"><span className="banner-kicker">UPCOMING TRIP</span><h2>{s.trip.dest || s.trip.name}</h2><p>{s.trip.name}</p><div className="banner-pill">✈ &nbsp; {s.trip.days} amazing days ahead</div></div><div className="destination-art" aria-hidden="true"><div className="sun-disc"></div><div className="colosseum"><div className="arch-row">{Array.from({length:5},(_,i)=><i key={i}/>)}</div><div className="arch-row">{Array.from({length:5},(_,i)=><i key={i}/>)}</div><div className="arch-row">{Array.from({length:5},(_,i)=><i key={i}/>)}</div></div></div></section>
            <div className="summary-row"><TravelDateCard
  start={s.trip.start}
  days={s.trip.days}
  maxActivityDay={Math.max(0, ...s.activities.map((a:S) => a.day))}
  onSave={(start, days) => call('/dates', 'PATCH', {start, days})}
/><CrewCard
  members={s.members}
  me={s.me}
  isOrganizer={s.is_organizer}
  onRemove={async (id: number) => {
    try {
      await api("/trips/" + code + "/members/" + id, code, {
        method: "DELETE"
      });
      await load();
    } catch (e: any) {
      setErr(e.message);
      throw e;
    }
  }}
  onInvite={() => {
    navigator.clipboard.writeText(location.href);
    setErr("Invite link copied!");
  }}
/><section className="summary-card"><span className="tile-icon blue">♧</span><p>Destination</p><h3>{s.trip.dest || 'Anywhere'}</h3><small>✦ &nbsp; Let's make memories</small></section></div>
            <div className="section-title-row"><div><p className="eyebrow">STAY ON TRACK</p><h2>Trip itinerary</h2></div><button className="outline-action" onClick={()=>setShowActivity(!showActivity)}>{showActivity?'Close':'＋ Add activity'}</button></div>
            {showActivity && <form className="card activity-form" onSubmit={(e)=>{const d=fd(e);call('/activities','POST',{title:d.get('title'),day:+(d.get('day') as string),time:d.get('time'),loc:d.get('loc')});(e.target as HTMLFormElement).reset();setShowActivity(false);}}><label>Activity<input name="title" required placeholder="Colosseum tour"/></label><div className="two"><label>Day<select name="day" defaultValue={selectedDay}>{days.map((d)=><option key={d} value={d}>{dayLabel(d)}</option>)}</select></label><label>Time<input type="time" name="time"/></label></div><label>Location<input name="loc" placeholder="Add a place (optional)"/></label><button className="pri">Save activity</button></form>}
            <div className="day-selector">{days.map((d)=><button key={d} onClick={()=>setSelectedDay(d)} className={selectedDay===d?'selected':''}><span>DAY {d}</span><strong>{prettyDate(d)}</strong></button>)}</div>
            <div className="itinerary-card"><div className="itinerary-head"><h3>{dayLabel(selectedDay)}</h3><span>{currentActivities.length} {currentActivities.length===1?'activity':'activities'}</span></div>{currentActivities.length?currentActivities.map((a:S,i:number)=><div key={a.id} className="itinerary-entry"><div className="entry-symbol">{['✈','✿','⌂','☀'][i%4]}</div><div className="entry-body"><strong>{a.title}</strong><small>{a.loc || `Added by ${nameOf(a.by)}`}</small></div><div className="entry-time">{a.time||'Anytime'}</div><button className="entry-remove" title="Remove activity" onClick={()=>call('/activities/'+a.id,'DELETE')}>×</button></div>):<div className="empty-activities"><span>✧</span><strong>Your day is a blank canvas</strong><p>Start adding activities or let your crew vote on ideas.</p><button className="text-action" onClick={()=>setShowActivity(true)}>＋ Plan something fun</button></div>}</div>
          </main>
          <aside className="dashboard-rail"><div className="rail-header"><h2>Trip timeline</h2></div><section className="rail-calendar"><div className="month-line"><strong>{monthName}</strong><span>✧</span></div><div className="calendar-days">{days.slice(0,14).map((d)=><button key={d} onClick={()=>setSelectedDay(d)} className={selectedDay===d?'chosen':''}><small>Day {d}</small><strong>{prettyDate(d).split(' ').slice(-1)[0]}</strong></button>)}</div></section><section className="rail-expenses"><div className="rail-section-heading"><h3>Expenses</h3><button onClick={()=>setTab('money')}>View all ↗</button></div><h2>{money(spent)}</h2><p>Total group spending</p><div className="spending-bar">{spent?categories.map(c=><div key={c.name} style={{width:(c.total/spent*100)+'%',background:c.color}}/>):<div style={{width:'100%',background:'#e9ebf3'}}/>}</div><div className="legend">{categories.map(c=><span key={c.name}><i style={{background:c.color}}/>{c.name}</span>)}</div></section><section className="rail-activity"><div className="rail-section-heading"><h3>Day {selectedDay} schedule</h3><span>{currentActivities.length} events</span></div>{currentActivities.length?currentActivities.map((a:S,i:number)=><div className={'rail-event event-'+(i%3)} key={a.id}><span>{a.time||'Anytime'}</span><strong>{a.title}</strong><small>{a.loc||'Group activity'}</small></div>):<div className="timeline-empty">☼<p>No events planned yet.<br/>Add an activity to get started.</p></div>}</section><button className="rail-poll" onClick={()=>setTab('polls')}><span>◉</span><div><strong>Make plans together</strong><small>{s.polls.length} group polls · Vote on ideas</small></div><span>→</span></button></aside>
        </div> : <div className="interior-page"><div className="intro-row"><div><p className="eyebrow">{s.trip.name.toUpperCase()}</p><h1>{tab==='polls'?'Group voting':tab==='money'?'Trip expenses':tab==='photos'?'Trip photos':tab==='map'?'Explore Map':'AI trip ideas'}</h1><p className="sub">{tab==='polls'?'Let everyone have a say.':tab==='money'?'Track spending and settle up effortlessly.':tab==='photos'?'Upload and download your favorite moments together.':tab==='map'?'Find hotels, restaurants, and attractions nearby.':'Find something amazing for your next adventure.'}</p></div><button className="outline-action" onClick={()=>setTab('plan')}>← Overview</button></div><div className="interior-content">{tab==='polls'&&<PollTab s={s} call={call} dayLabel={dayLabel} days={days}/>}{tab==='money'&&<MoneyTab s={s} call={call} nameOf={nameOf}/>}{tab==='photos'&&<TripPhotos code={code} members={s.members} />}{tab==='ai'&&<AiTab code={code} days={days} dayLabel={dayLabel} call={call}/>}{tab==='map'&&<ExploreMap destination={s.trip.dest || s.trip.name} code={code} days={days} dayLabel={dayLabel} reload={load}/>}</div></div>}
      </div>
    </div>
  );
}



function TravelDateCard({
  start,
  days,
  maxActivityDay,
  onSave,
}: {
  start: string;
  days: number;
  maxActivityDay: number;
  onSave: (start: string, days: number) => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [begin, setBegin] = useState(start);
  const [end, setEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addDays = (value: string, n: number) => {
    const d = new Date(value + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const duration = begin && end
    ? Math.round(
        (Date.parse(end + "T12:00:00Z") -
         Date.parse(begin + "T12:00:00Z")) / 86400000
      ) + 1
    : 0;

  const valid = duration >= 1 && duration <= 30;
  const conflicts = valid && maxActivityDay > duration;

  const label = (value: string) => value
    ? new Date(value + "T12:00:00Z").toLocaleDateString(
        undefined, {month: "short", day: "numeric"}
      )
    : "Not set";

  const openEditor = () => {
    const initial = start || new Date().toLocaleDateString("en-CA");
    setBegin(initial);
    setEnd(addDays(initial, days - 1));
    setError("");
    setOpen(true);
  };

  const save = async () => {
    if (!valid || conflicts || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(begin, duration);
      setOpen(false);
    } catch {
      setError("Could not save dates. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section
        className="summary-card travel-date-clickable"
        role="button"
        tabIndex={0}
        aria-label="Edit travel dates"
        onClick={openEditor}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openEditor();
          }
        }}
      >
        <span className="tile-icon orange">▦</span>
        <p>Travel date</p>
        <h3>{days} days</h3>
        <small>
          {start ? label(start) : "Choose date"}
          <span className="exchange"> ⇄ </span>
          {start ? label(addDays(start, days - 1)) : "Choose date"}
        </small>
      </section>

      {open && (
        <div
          className="crew-modal-backdrop"
          onClick={() => setOpen(false)}
        >
          <div
            className="crew-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit trip dates"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="crew-modal-header">
              <div>
                <h2>Edit trip dates ✈️</h2>
                <p>Adjust your adventure schedule</p>
              </div>
              <button
                className="crew-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >×</button>
            </div>

            <div className="trip-date-fields">
              <label>
                Start date
                <input
                  type="date"
                  value={begin}
                  onChange={(e) => setBegin(e.target.value)}
                />
              </label>
              <label>
                End date
                <input
                  type="date"
                  value={end}
                  min={begin}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
            </div>

            <div className="trip-duration-preview">
              <strong>{valid ? duration + " days" : "Invalid dates"}</strong>
              <small>Updated trip duration</small>
            </div>

            {conflicts && (
              <p className="trip-date-warning">
                Your itinerary contains activities through Day {maxActivityDay}.
                Move those activities before shortening the trip.
              </p>
            )}

            {!valid && (
              <p className="trip-date-warning">
                Choose a trip duration between 1 and 30 days.
              </p>
            )}

            {error && <p className="trip-date-warning">{error}</p>}

            <button
              className="crew-invite-action"
              disabled={!valid || conflicts || saving}
              onClick={save}
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function CrewCard({
  members,
  me,
  isOrganizer,
  onRemove,
  onInvite,
}: {
  members: { id: number; name: string }[];
  me: number | null;
  isOrganizer: boolean;
  onRemove: (id: number) => Promise<void>;
  onInvite: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");

  return (
    <>
      <section
        className="summary-card crew-clickable"
        role="button"
        tabIndex={0}
        aria-label="View travel crew"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="tile-icon violet">♧</span>
        <p>Travel crew</p>
        <h3>
          {members.length} <span className="normal-weight">people</span>
        </h3>
        <div className="crew-list">
          {members.slice(0, 4).map((m, i) => (
            <span
              key={m.id}
              className={"crew-avatar crew-" + (i % 4)}
              title={m.name}
            >
              {m.name.charAt(0).toUpperCase()}
            </span>
          ))}
          <button
            title="Copy invite link"
            onClick={(e) => {
              e.stopPropagation();
              onInvite();
            }}
          >
            +
          </button>
        </div>
      </section>

      {open && (
        <div
          className="crew-modal-backdrop"
          onClick={() => setOpen(false)}
        >
          <div
            className="crew-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Travel crew"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="crew-modal-header">
              <div>
                <h2>Travel crew ✈️</h2>
                <p>{members.length} people on this trip</p>
              </div>
              <button
                className="crew-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="crew-members">
              {members.map((m, i) => (
                <div className="crew-member-profile" key={m.id}>
                  <div className={"crew-profile-avatar crew-" + (i % 4)}>
                    {m.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="crew-profile-info">
                    <strong>{m.name}</strong>
                    <small>
                      {m.id === me
                        ? (isOrganizer ? "You · Organizer" : "You · Trip member")
                        : "Trip member"}
                    </small>
                  </div>
                  {isOrganizer && m.id !== me && (
                    <button
                      type="button"
                      className="crew-remove-button"
                      onClick={() => {
                        setRemoveError("");
                        setRemoving(m.id);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>

            {removing !== null && (
              <div className="crew-removal-confirm">
                <p>
                  Remove {members.find(m => m.id === removing)?.name}
                  {" "}from this trip?
                </p>
                <small>
                  Their current access will be revoked.
                  Historical contributions will be preserved.
                </small>
                {removeError && <p role="alert">{removeError}</p>}
                <div className="crew-confirm-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await onRemove(removing);
                        setRemoving(null);
                      } catch {
                        setRemoveError("Unable to remove member.");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? "Removing..." : "Confirm removal"}
                  </button>
                </div>
              </div>
            )}

            <button
              className="crew-invite-action"
              onClick={() => {
                onInvite();
                setOpen(false);
              }}
            >
              + Invite another traveler
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function PollTab({ s, call, dayLabel, days }: S) {
  const [n, setN] = useState(2);
  return <>
    <form className="card" onSubmit={(e) => { const d = fd(e); call("/polls", "POST", { question: d.get("q"), day: +(d.get("day") as string), options: d.getAll("o") }); (e.target as HTMLFormElement).reset(); setN(2); }}>
      <label>Question<input name="q" required placeholder="What should we do in the afternoon?" /></label>
      {Array.from({ length: n }, (_, i) => <input key={i} name="o" placeholder={"Option " + (i + 1)} />)}
      <button type="button" className="ghost" onClick={() => setN(n + 1)}>Add another option</button>
      <label>Day<select name="day">{days.map((d: number) => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
      <button className="pri">Create poll</button></form>
    {s.polls.map((p: S) => { const tot = p.counts.reduce((a: number, b: number) => a + b, 0), mx = Math.max(...p.counts), lead = mx > 0 && p.counts.filter((c: number) => c === mx).length === 1 ? p.counts.indexOf(mx) : -1;
      return <div className="card" key={p.id}><b>{p.question}</b><p className="sub">{dayLabel(p.day)} · {tot} {tot === 1 ? "vote" : "votes"}</p>
        {p.options.map((o: string, i: number) => <button key={i} className="opt" aria-pressed={p.mine === i} onClick={() => call(`/polls/${p.id}/vote`, "POST", { option: i })}>
          <i style={{ width: tot ? (p.counts[i] / tot) * 100 + "%" : 0 }} /><span>{o}</span><span>{p.counts[i]}</span></button>)}
        {lead >= 0 && <button className="ghost" style={{ marginTop: ".6rem" }} onClick={() => call("/activities", "POST", { title: p.options[lead], day: p.day })}>Add “{p.options[lead]}” to {dayLabel(p.day)}</button>}</div>; })}
    {!s.polls.length && <p className="sub">No polls yet. Create one and send the link.</p>}
  </>;
}

function MoneyTab({ s, call, nameOf }: S) {
  const [mode, setMode] = useState<"even" | "custom">("even");
  const [sel, setSel] = useState<number[]>(s.members.map((m: S) => m.id)); const [pct, setPct] = useState<Record<number, string>>({}); const [e2, setE2] = useState("");
  const submit = (e: FormEvent) => {
    const d = fd(e); const amt = +(d.get("amount") as string); setE2("");
    if (!sel.length) return setE2("Pick at least one person to split with.");
    const p = sel.map((id) => (mode === "even" ? 100 / sel.length : +(pct[id] ?? 100 / sel.length)));
    if (Math.abs(p.reduce((a, b) => a + b, 0) - 100) > 0.5) return setE2("Percentages need to total 100.");
    const shares: Record<number, number> = {}; sel.forEach((id, i) => (shares[id] = Math.round(amt * p[i]) / 100)); // rounded to cents
    const diff = Math.round((amt - Object.values(shares).reduce((a, b) => a + b, 0)) * 100) / 100; shares[sel[0]] = Math.round((shares[sel[0]] + diff) * 100) / 100;
    call("/expenses", "POST", { desc: d.get("desc"), cat: d.get("cat"), amount: amt, paid_by: +(d.get("paid") as string), shares }); (e.target as HTMLFormElement).reset();
  };
  return <>
    <form className="card" onSubmit={submit}>
      <label>What was it for?<input name="desc" required /></label>
      <div className="two"><label>Amount ($)<input name="amount" type="number" step="0.01" min="0.01" required /></label>
        <label>Category<select name="cat"><option>Food and drinks</option><option>Stay</option><option>Transport</option><option>Activities</option><option>Other</option></select></label></div>
      <label>Paid by<select name="paid" defaultValue={s.me}>{s.members.map((m: S) => <option key={m.id} value={m.id}>{nameOf(m.id)}</option>)}</select></label>
      <div className="inl"><button type="button" className="ghost" aria-pressed={mode === "even"} onClick={() => setMode("even")}>Even split</button><button type="button" className="ghost" aria-pressed={mode === "custom"} onClick={() => setMode("custom")}>Custom split</button></div>
      <div className="inl">{s.members.map((m: S) => <button type="button" key={m.id} className="ghost" aria-pressed={sel.includes(m.id)} onClick={() => setSel(sel.includes(m.id) ? sel.filter((x) => x !== m.id) : [...sel, m.id])}>{nameOf(m.id)}</button>)}</div>
      {mode === "custom" && sel.map((id) => <label key={id}>{nameOf(id)} (% of total)<input type="number" min={0} max={100} value={pct[id] ?? Math.round((1000 / sel.length)) / 10} onChange={(e) => setPct({ ...pct, [id]: e.target.value })} /></label>)}
      {e2 && <p className="err">{e2}</p>}<button className="pri">Save expense</button></form>
    <div className="card"><h2>Who pays who</h2>{s.settle.map((t: S, i: number) => <div className="pay" key={i}>{nameOf(t.from)} {t.from === s.me ? "pay" : "pays"} {nameOf(t.to)} <b>{money(t.amount)}</b></div>)}
      {!s.settle.length && <p className="sub">{s.expenses.length ? "Everyone is settled up." : "Add an expense to see who owes who."}</p>}</div>
    <div className="card"><h2>Expenses</h2>{s.expenses.map((x: S) => <div className="row" key={x.id}><span><b>{x.desc}</b><p className="sub">{x.cat} · {nameOf(x.paid_by)} paid</p></span>
      <span>{money(x.amount)}<br /><button className="x" onClick={() => call("/expenses/" + x.id, "DELETE")}>Remove</button></span></div>)}</div>
  </>;
}

function AiTab({ code, days, dayLabel, call }: S) {
  const [ideas, setIdeas] = useState<S[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const go = async (e: FormEvent) => {
    const d = fd(e); setBusy(true); setErr("");
    try { const r = await api<any>(`/trips/${code}/suggest`, code, { method: "POST", body: JSON.stringify({ wish: d.get("wish") }) }); setIdeas(r.ideas); } catch (x: any) { setErr(x.message); }
    setBusy(false);
  };
  return <>
    <form className="card" onSubmit={go}><label>What is the group in the mood for?<input name="wish" placeholder="Cheap eats, one museum, lots of walking" /></label>
      <p className="sub">Suggestions use your destination, existing plans and poll winners.</p><button className="pri" disabled={busy}>{busy ? "Thinking…" : "Suggest activities"}</button></form>
    {err && <p className="err">{err}</p>}
    {ideas.map((i, k) => <div className="card act" key={k}><span className="time">{i.time || "--:--"}</span><div><b>{i.title}</b><p className="sub">{dayLabel(Math.min(i.day, days.length))}{i.loc ? " · " + i.loc : ""}</p></div>
      <button className="ghost" onClick={() => { call("/activities", "POST", i); setIdeas(ideas.filter((_, j) => j !== k)); }}>Add</button></div>)}
  </>;
}
