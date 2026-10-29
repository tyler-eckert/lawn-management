// Supabase Edge Function: turf-digest
// The TurfOps morning digest: an email (and/or a phone push) that answers "water today?"
//
//   GET  ?vapid=1                         -> { key }  the public Web Push key (safe to share)
//   GET  ?token=<digest token>            -> called hourly by pg_cron; sends to everyone whose send hour is now
//        &force=1                         -> ignore the send hour and today's "already sent" mark
//   POST { action: "test" | "preview" }   -> from the app, with the signed-in member's session:
//                                            test sends to that member now, preview returns { subject, html, push }
//
// Deploy with JWT verification OFF (the cron call has no login; the POST checks the session itself).
// Secrets, all already set for the band app on this project:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (+ optional VAPID_SUBJECT)            -> push
//   TURF_GMAIL_USER + TURF_GMAIL_APP_PASSWORD -> email from your own Gmail (preferred)
//   otherwise the band's: RESEND_API_KEY + DIGEST_FROM, or GMAIL_USER + GMAIL_APP_PASSWORD
//   TURF_DIGEST_FROM (optional)  e.g. "TurfOps <turf@eckerthaus.com>"; otherwise DIGEST_FROM's address is used
//   BHYVE_EMAIL, BHYVE_PASSWORD                                                -> controller section (optional)
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!, SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const APP = "https://turf.eckerthaus.com/";
const TZ = "America/Chicago";
const SITE = { lat: 35.70, lon: -97.40 };
const THRESH: Record<string, number> = { bermuda: 0.65, fescue: 0.45 };   // same as DEFICIT_THRESHOLD_IN in the app
const AVG_FROM = 2010, AVG_TO = 2025;
const PROGRAM_NAMES: Record<string, string> = { a: "Backyard", b: "Flower Beds", c: "Fescue", d: "Front & East" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------------- small helpers ---------------- */
const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
const f2 = (v: number | null) => (v == null || !isFinite(v) ? "-" : v.toFixed(2));
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeHtml = (h: string) => h.replace(/[^\x00-\x7F]/g, (c) => `&#${c.codePointAt(0)};`);
const plain = (t: string) => t.replace(/[‒-―]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/[·•]/g, "-").replace(/₀/g, "0").replace(/°/g, " F").normalize("NFKD").replace(/[^\x00-\x7F]/g, "");
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const hourCT = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));
const addDays = (k: string, i: number) => new Date(Date.parse(k + "T12:00:00Z") + i * 864e5).toISOString().slice(0, 10);
const dow = (k: string) => new Date(k + "T12:00:00Z").getUTCDay();
const wk = (k: string) => new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const wkLong = (k: string) => new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const md = (k: string) => new Date(k + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const zoneList = (zs: number[]) => {   // [1,2,3,4,5,8,9] -> "1-5, 8, 9"
  const s = [...new Set(zs)].sort((a, b) => a - b), out: string[] = [];
  for (let i = 0; i < s.length; i++) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(j - i >= 2 ? `${s[i]}-${s[j]}` : s.slice(i, j + 1).join(", ")); i = j; }
  return out.join(", ");
};

async function allRows(table: string, cols: string, apply: (q: any) => any, page = 1000) {
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await apply(db.from(table).select(cols)).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < page) return out;
  }
}

/* ---------------- forecast (same math as the app's loadRainForecast) ---------------- */
function isoHours(dur: string) { const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(dur || ""); return m ? (+(m[1] || 0)) * 24 + (+(m[2] || 0)) : 1; }
async function forecast(today: string) {
  const H = { Accept: "application/geo+json", "User-Agent": "TurfOps digest (turf.eckerthaus.com)" };
  const pt = await fetch(`https://api.weather.gov/points/${SITE.lat},${SITE.lon}`, { headers: H });
  if (!pt.ok) throw new Error("NWS points " + pt.status);
  const grid = await fetch((await pt.json()).properties.forecastGridData, { headers: H });
  if (!grid.ok) throw new Error("NWS grid " + grid.status);
  const P = (await grid.json()).properties, days: Record<string, { rain: number; pop: number }> = {};
  ((P.quantitativePrecipitation || {}).values || []).forEach((v: any) => {
    const [start, dur] = v.validTime.split("/"), hrs = isoHours(dur), t0 = new Date(start).getTime(), perHr = (v.value || 0) / 25.4 / hrs;
    for (let h = 0; h < hrs; h++) { const k = dayKey(new Date(t0 + h * 3600e3)); (days[k] ||= { rain: 0, pop: 0 }).rain += perHr; }
  });
  ((P.probabilityOfPrecipitation || {}).values || []).forEach((v: any) => {
    const [start, dur] = v.validTime.split("/"), hrs = isoHours(dur), t0 = new Date(start).getTime();
    for (let h = 0; h < hrs; h++) { const k = dayKey(new Date(t0 + h * 3600e3)); (days[k] ||= { rain: 0, pop: 0 }).pop = Math.max(days[k].pop, v.value || 0); }
  });
  return Object.keys(days).filter((k) => k >= today).sort().slice(0, 7).map((k) => ({ date: k, rain: Math.round(days[k].rain * 100) / 100, pop: Math.round(days[k].pop) }));
}

/* ---------------- B-hyve (read only) ---------------- */
async function controller() {
  const email = Deno.env.get("BHYVE_EMAIL"), password = Deno.env.get("BHYVE_PASSWORD");
  if (!email || !password) return null;
  const BASE = "https://api.orbitbhyve.com/v1", APP_ID = "Orbit Support Dashboard";
  const r = await fetch(`${BASE}/session`, { method: "POST", headers: { "Content-Type": "application/json", "orbit-app-id": APP_ID }, body: JSON.stringify({ session: { email, password } }) });
  if (!r.ok) throw new Error("B-hyve login " + r.status);
  const a = await r.json(), h = { "orbit-api-key": a.orbit_api_key, "orbit-session-token": a.orbit_session_token || a.orbit_api_key, "orbit-app-id": APP_ID };
  const dr = await fetch(`${BASE}/devices?user_id=${a.user_id}`, { headers: h });
  if (!dr.ok) throw new Error("B-hyve devices " + dr.status);
  const dev = ((await dr.json()) as any[]).find((d) => d.type === "sprinkler_timer"); if (!dev) return null;
  const pr = await fetch(`${BASE}/sprinkler_timer_programs?device_id=${dev.id}`, { headers: h });
  const progs = pr.ok ? ((await pr.json()) as any[]) : [];
  const delayH = Number(dev.status?.rain_delay || 0), started = dev.status?.rain_delay_started_at ? Date.parse(dev.status.rain_delay_started_at) : null;
  const delayLeft = delayH && started ? Math.max(0, Math.round((started + delayH * 3600e3 - Date.now()) / 3600e3)) : delayH;
  return { name: dev.name || "Controller", delayLeft, programs: progs.map((p) => ({ name: p.name, letter: p.program, budget: p.budget, enabled: p.enabled !== false, zones: (p.run_times || []).map((t: any) => t.station) })) };
}

/* ---------------- the numbers ---------------- */
async function gather() {
  const now = new Date(), today = dayKey(now), yest = addDays(today, -1), yr = today.slice(0, 4);
  // week so far = Sunday through yesterday; on a Sunday it's all of last week
  const sun = dow(today) === 0 ? addDays(today, -7) : addDays(today, -dow(today));
  const weekEnd = dow(today) === 0 ? addDays(today, -1) : yest;
  const [grass, weather, runs, fc, ctl] = await Promise.all([
    allRows("et_balance_by_grass", "weather_date,grass_type,etc_in,net_deficit_in,irrigation_applied_in,rain_in", (q) => q.in("grass_type", ["bermuda", "fescue"]).gte("weather_date", `${yr}-01-01`).lte("weather_date", today).order("weather_date")),
    allRows("weather_daily", "weather_date,temp_high_f,temp_low_f,rain_in,et0_in", (q) => q.gte("weather_date", `${AVG_FROM}-01-01`).lte("weather_date", today).order("weather_date")),
    allRows("irrigation_runs", "run_date,zone_number,program,runtime_minutes,start_time,status", (q) => q.gte("run_date", yest).lte("run_date", today).order("start_time")),
    forecast(today).catch((e) => { console.error(e); return null; }),
    controller().catch((e) => { console.error(e); return null; }),
  ]);

  // "Water today?" -- identical rules to renderWaterToday() in the app
  const rain48 = fc ? sum(fc.slice(0, 2).map((d) => d.rain)) : null;
  const G = ["bermuda", "fescue"].map((g) => {
    const rows = grass.filter((r) => r.grass_type === g && r.weather_date < today);   // through yesterday: today's partial day never counts
    let run = 0; rows.forEach((r) => { const d = n(r.net_deficit_in); if (d != null) run = Math.max(0, run + d); });
    const last7 = rows.slice(-7).map((r) => n(r.etc_in)).filter((v): v is number => v != null), pace = last7.length ? avg(last7) : 0;
    const T = THRESH[g], W = T * 0.8;
    let state: string, line: string;
    if (run >= T && rain48 != null && rain48 >= run * 0.8) { state = "hold"; line = `${f2(run)} in behind, but ${f2(rain48)} in of rain is expected in the next 2 days.`; }
    else if (run >= T) { state = "water"; line = `${f2(run)} in behind (irrigate at ${f2(T)}).`; }
    else if (run >= W) { const d = pace > 0 ? Math.max(1, Math.ceil((T - run) / pace)) : null; state = "watch"; line = `About ${d ? d + " day" + (d > 1 ? "s" : "") : "a few days"} until it needs water.`; }
    else { const d = pace > 0 ? Math.ceil((T - run) / pace) : null; state = "ok"; line = d ? `About ${d} days at this week's pace.` : "Caught up."; }
    const y = rows.find((r) => r.weather_date === yest);
    const wkRows = rows.filter((r) => r.weather_date >= sun && r.weather_date <= weekEnd);
    return { g, name: g === "bermuda" ? "Bermuda" : "Fescue", run, T, W, state, line,
      yNeed: y ? n(y.etc_in) : null, yGot: y ? (n(y.irrigation_applied_in) || 0) + (n(y.rain_in) || 0) : null,
      wNeed: sum(wkRows.map((r) => n(r.etc_in) || 0)), wGot: sum(wkRows.map((r) => (n(r.irrigation_applied_in) || 0) + (n(r.rain_in) || 0))) };
  });
  const any = (s: string) => G.filter((x) => x.state === s);
  const head = any("water").length ? "Yes, water today" : any("hold").length ? "Hold off, rain is coming" : any("watch").length ? "Not yet, but soon" : "No watering needed";
  const level = any("water").length ? "water" : any("hold").length ? "hold" : any("watch").length ? "watch" : "ok";
  const wetDay = fc ? [...fc].sort((a, b) => b.rain - a.rain)[0] : null;
  const rainNote = wetDay && wetDay.rain >= 0.1 ? `${f2(wetDay.rain)} in of rain is likely ${wetDay.date === today ? "today" : wkLong(wetDay.date)} (${wetDay.pop}%)` : null;
  let reason: string;
  if (level === "water") reason = any("water").map((x) => `${x.name} is ${x.line}`).join(" ") + (rain48 != null ? (rain48 >= 0.05 ? ` ${f2(rain48)} in of rain in the next 2 days.` : " No rain in the next 2 days.") : "");
  else if (level === "hold") reason = any("hold").map((x) => `${x.name} is ${x.line}`).join(" ");
  else if (level === "watch") reason = any("watch").map((x) => `${x.name}: ${x.line}`).join(" ") + (rainNote ? ` ${rainNote[0].toUpperCase() + rainNote.slice(1)}.` : "");
  else reason = `Both grasses are caught up${rainNote ? `, and ${rainNote}` : ""}.`;

  // yesterday's weather and watering
  const wy = weather.find((r) => r.weather_date === yest);
  const progName = (letter: string) => (ctl?.programs.find((p) => p.letter === letter)?.name) || PROGRAM_NAMES[letter] || `Program ${String(letter || "?").toUpperCase()}`;
  const runGroups = (day: string) => {
    const by: Record<string, Record<number, number>> = {};
    runs.filter((r) => r.run_date === day && r.status !== "skipped").forEach((r) => { const p = r.program || "?"; (by[p] ||= {})[r.zone_number] = ((by[p] ||= {})[r.zone_number] || 0) + (n(r.runtime_minutes) || 0); });
    return Object.entries(by).map(([p, z]) => {
      const mins = Object.values(z).map((m) => Math.round(m)), lo = Math.min(...mins), hi = Math.max(...mins);
      const zs = Object.keys(z).map(Number);
      return { name: progName(p), zones: (zs.length > 1 ? "zones " : "zone ") + zoneList(zs), mins: lo === hi ? `${lo} min${Object.keys(z).length > 1 ? " each" : ""}` : `${lo}-${hi} min` };
    });
  };

  // season so far vs. the 2010-2025 average to the same date
  const mmdd = today.slice(5), yrs = Array.from({ length: AVG_TO - AVG_FROM + 1 }, (_, i) => String(AVG_FROM + i));
  const thisYr = weather.filter((r) => r.weather_date.startsWith(yr));
  const toDate = (y: string) => weather.filter((r) => r.weather_date >= `${y}-01-01` && r.weather_date <= `${y}-${mmdd}`);
  const rainYtd = sum(thisYr.map((r) => n(r.rain_in) || 0));
  const rainAvg = avg(yrs.map((y) => toDate(y)).filter((rows) => rows.length > 200 || mmdd < "08-01").map((rows) => sum(rows.map((r) => n(r.rain_in) || 0))));
  const hot = (rows: any[]) => rows.filter((r) => (n(r.temp_high_f) || 0) >= 100).length;
  const hotYtd = hot(thisYr), hotAvg = avg(yrs.map((y) => hot(toDate(y))));
  // first freeze after Aug 1 (fall) or last freeze before Jul 1 (spring), as day-of-year medians
  const doy = (k: string) => Math.round((Date.parse(k + "T12:00:00Z") - Date.parse(k.slice(0, 4) + "-01-01T12:00:00Z")) / 864e5);
  const fromDoy = (d: number) => md(addDays(`${yr}-01-01`, d));
  const fall = mmdd >= "08-01";
  const frz = yrs.map((y) => { const rows = weather.filter((r) => r.weather_date.startsWith(y) && (fall ? r.weather_date.slice(5) >= "08-01" : r.weather_date.slice(5) < "07-01") && n(r.temp_low_f) != null && n(r.temp_low_f)! <= 32);
    return rows.length ? doy(fall ? rows[0].weather_date : rows[rows.length - 1].weather_date) : null; }).filter((v): v is number => v != null);
  const frzThis = thisYr.filter((r) => (fall ? r.weather_date.slice(5) >= "08-01" : r.weather_date.slice(5) < "07-01") && n(r.temp_low_f) != null && n(r.temp_low_f)! <= 32);
  const frzMed = median(frz);
  const freeze = fall
    ? (frzThis.length ? { label: "First freeze", value: `${md(frzThis[0].weather_date)} (avg ${frzMed != null ? fromDoy(frzMed) : "-"})` } : frzMed != null ? { label: "First freeze (avg)", value: `about ${fromDoy(frzMed)}` } : null)
    : (frzMed != null ? { label: "Last freeze (avg)", value: `about ${fromDoy(frzMed)}${frzThis.length ? ` · this year ${md(frzThis[frzThis.length - 1].weather_date)} so far` : ""}` } : null);

  return { today, yest, sun, weekEnd, G, head, level, reason, rain48, fc, ctl, wy,
    ranY: runGroups(yest), ranT: runGroups(today),
    season: { rainYtd, rainAvg, hotYtd, hotAvg, freeze } };
}

/* ---------------- the email ---------------- */
const C = { ink: "#050806", mute: "#68726c", line: "#e6ebe8", soft: "#f4f6f5", card: "#ffffff", green: "#1a8f4e", deep: "#0e3b27", water: "#4472C4", warn: "#b57b00", red: "#d14343" };
const LOGO = `<img src="${APP}brand/turfops-icon-180.png" width="34" height="34" alt="TurfOps" style="display:block;border:0;border-radius:9px">`;

function build(D: Awaited<ReturnType<typeof gather>>, who: { calc?: any[] | null; calcAt?: string | null }) {
  const alert = D.level === "water";
  const card = (inner: string, extra = "") => `<tr><td style="padding:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:16px;${extra}"><tr><td style="padding:16px">${inner}</td></tr></table></td></tr>`;
  const eyebrow = (t: string, col = C.mute) => `<div style="font-size:11px;font-weight:700;color:${col};text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">${t}</div>`;
  const row = (l: string, r: string, first = false) => `<tr><td style="padding:8px 0;${first ? "" : `border-top:1px solid ${C.line};`}font-size:14px;color:${C.ink}">${l}</td><td align="right" style="padding:8px 0;${first ? "" : `border-top:1px solid ${C.line};`}font-size:12.5px;color:${C.mute}">${r}</td></tr>`;

  // hero
  const heroBg = alert ? "#8f1f1f" : C.deep, heroImg = alert ? "linear-gradient(135deg,#3a0b0b 0%,#8f1f1f 55%,#d14343 110%)" : "linear-gradient(135deg,#04140c 0%,#0e3b27 48%,#167a43 100%)";
  const meterCol = alert ? "#ffd0d0" : "#7fcf9f";
  const gcell = (x: any) => `<td width="50%" valign="top" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,.12);border-radius:12px"><tr><td style="padding:10px">
    <div style="font-size:11.5px;color:#cfe3d8;font-weight:600">${x.name}</div>
    <div style="font-size:18px;font-weight:700;color:#fff;margin-top:2px">${f2(x.run)} in</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px"><tr><td style="background:rgba(255,255,255,.2);border-radius:9px;height:5px;line-height:5px;font-size:0"><div style="width:${Math.max(1, Math.min(100, Math.round(x.run / x.T * 100)))}%;height:5px;background:${meterCol};border-radius:9px"></div></td></tr></table>
    <div style="font-size:11px;color:#cfe3d8;margin-top:4px">behind · irrigate at ${f2(x.T)}</div></td></tr></table></td>`;
  const hero = `<tr><td style="padding:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${heroBg};background-image:${heroImg};border-radius:16px"><tr><td style="padding:18px 16px">
    ${eyebrow("Water today?", "#cfe3d8")}
    <div style="font-size:26px;font-weight:700;color:#fff;letter-spacing:-.02em;line-height:1.15">${esc(D.head)}</div>
    <div style="font-size:14px;color:#e8f2ec;margin-top:6px;line-height:1.45">${esc(D.reason)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr>${D.G.map(gcell).join("")}</tr></table>
    ${alert ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr><td style="background:#fff;border-radius:99px"><a href="${APP}#calculator" style="display:inline-block;padding:10px 18px;font-size:13.5px;font-weight:700;color:${C.ink};text-decoration:none">Review budgets in TurfOps</a></td></tr></table>` : ""}
  </td></tr></table></td></tr>`;

  // yesterday
  const wy = D.wy, kv = (l: string, v: string, u: string) => `<td width="33%" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border-radius:12px"><tr><td style="padding:10px 8px 10px 10px"><div style="font-size:11px;color:${C.mute};font-weight:600;white-space:nowrap">${l}</div><div style="font-size:19px;font-weight:700;color:${C.ink};margin-top:2px;white-space:nowrap">${v}<span style="font-size:11px;color:${C.mute};font-weight:600;margin-left:2px">${u}</span></div></td></tr></table></td>`;
  const ranRows = [...D.ranY.map((r) => row(`${esc(r.name)} ran`, `${esc(r.zones)} · ${esc(r.mins)}`)), ...D.ranT.map((r) => row(`${esc(r.name)} ran this morning`, `${esc(r.zones)} · ${esc(r.mins)}`))];
  const yesterday = card(eyebrow(`Yesterday · ${wk(D.yest)} ${md(D.yest)}`)
    + (wy ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px"><tr>${kv("High / low", `${Math.round(n(wy.temp_high_f) ?? 0)}&#176;`, `/ ${Math.round(n(wy.temp_low_f) ?? 0)}&#176;`)}${kv("Rain", f2(n(wy.rain_in)), "in")}${kv("ET", `<span style="white-space:nowrap;font-size:15px;letter-spacing:-.03em">${f2(D.G[0].yNeed)} / ${f2(D.G[1].yNeed)}</span>`, "")}</tr></table>` : `<div style="font-size:13px;color:${C.mute}">No weather row for yesterday yet.</div>`)
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">${ranRows.length ? ranRows.join("") : row("No programs ran", "", true)}`
    + row("Need vs. got", D.G.map((x) => `${x.name} ${f2(x.yNeed)} / ${f2(x.yGot)}`).join(" · ")) + `</table>`);

  // week so far: a bar with the "needed" tick drawn inside it, built from table cells so every mail app shows it in front
  const meterBar = (gotPct: number, needPct: number, col: string) => {
    const g = Math.max(0, Math.min(100, Math.round(gotPct))), nd = Math.max(1, Math.min(99, Math.round(needPct)));
    const cell = (w: number, bg: string) => w > 0 ? `<td width="${w}%" style="background:${bg};height:10px;line-height:10px;font-size:0">&nbsp;</td>` : "";
    const tick = `<td width="1%" style="background:${C.ink};height:10px;line-height:10px;font-size:0">&nbsp;</td>`;   // widths add up to 100%, tick included
    const segs = g >= nd ? cell(nd, col) + tick + cell(g - nd - 1, col) + cell(100 - g, "#eef2f0") : cell(g, col) + cell(nd - g, "#eef2f0") + tick + cell(100 - nd - 1, "#eef2f0");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:5px;border-radius:5px;overflow:hidden;border-collapse:separate"><tr>${segs}</tr></table>`;
  };
  const bars = D.G.map((x) => { const top = Math.max(x.wGot, x.wNeed, 0.01) * 1.25, diff = x.wGot - x.wNeed;
    return `<div style="margin:8px 0 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:12.5px;font-weight:600;color:${C.ink}">${x.name}</td><td align="right" style="font-size:12.5px;color:${C.mute}">${f2(x.wGot)} got · ${f2(x.wNeed)} needed · ${diff >= 0 ? "+" : "-"}${f2(Math.abs(diff))}</td></tr></table>
      ${meterBar(x.wGot / top * 100, x.wNeed / top * 100, diff >= 0 ? C.green : C.warn)}</div>`; }).join("");
  const behind = D.G.filter((x) => x.wGot < x.wNeed - 0.02);
  const weekNote = behind.length ? `${behind.map((x) => x.name).join(" and ")} ${behind.length > 1 ? "are" : "is"} behind for the week.` : "Both are keeping up with what they've needed.";
  const week = card(eyebrow(`${D.weekEnd === D.yest && dow(D.today) !== 0 ? "This week so far" : "Last week"} · ${wk(D.sun)}-${wk(D.weekEnd)}`) + bars + `<div style="font-size:12.5px;color:#434c47;line-height:1.45;margin-top:8px">${weekNote} The black tick is what it needed.</div>`);

  // forecast
  let fcHtml = "";
  if (D.fc && D.fc.length) {
    const mx = Math.max(0.5, ...D.fc.map((d) => d.rain)), tot = sum(D.fc.map((d) => d.rain)), wet = [...D.fc].sort((a, b) => b.rain - a.rain)[0];
    fcHtml = card(eyebrow("Rain forecast · next 7 days") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${D.fc.map((d) => { const h = Math.max(2, Math.round(d.rain / mx * 78));
      return `<td align="center" valign="bottom" style="padding:0 2px"><div style="font-size:11.5px;font-weight:700;color:${C.ink}">${d.rain >= 0.01 ? f2(d.rain) : "0"}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px auto"><tr><td width="24" height="78" valign="bottom" style="background:#eef2f0;border-radius:7px;font-size:0;line-height:0"><div style="height:${h}px;background:${C.water};border-radius:7px"></div></td></tr></table>
        <div style="font-size:10px;font-weight:700;color:${C.water}">${d.pop}%</div><div style="font-size:11px;color:${C.mute};font-weight:600;margin-top:2px">${d.date === D.today ? "Today" : wk(d.date)}</div></td>`; }).join("")}</tr></table>`
      + `<div style="font-size:12.5px;color:#434c47;line-height:1.45;margin-top:8px"><b>${f2(tot)} in</b> expected this week${wet.rain >= 0.1 ? `, most of it ${wet.date === D.today ? "today" : wkLong(wet.date)}` : ""}.</div>`);
  }

  // controller
  let ctlHtml = "";
  if (D.ctl) {
    const calc = Array.isArray(who.calc) ? who.calc : [];
    const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const on = D.ctl.programs.filter((p) => p.enabled);
    const progRows = on.map((p, i) => { const c = calc.find((x: any) => norm(x.area) === norm(p.name) || norm(x.title) === norm(p.name));
      const want = c && c.pct != null ? Math.max(10, Math.min(200, Math.round(c.pct))) : null;
      const chip = want == null ? "" : want === p.budget ? `<span style="font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:99px;background:#e4f3ea;color:${C.green};margin-left:6px">matches</span>` : `<span style="font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:99px;background:#fdf3dc;color:${C.warn};margin-left:6px">calc ${want}%</span>`;
      return row(`<b style="font-weight:600">${esc(p.name)}</b>`, `<span style="color:${C.ink};font-size:13px">${p.budget}%</span>${chip}`, i === 0); });
    progRows.push(row("Rain delay", D.ctl.delayLeft ? `${D.ctl.delayLeft} h left` : "none", !progRows.length));
    const suggestDelay = !D.ctl.delayLeft && D.rain48 != null && D.rain48 >= 0.25;
    ctlHtml = card(eyebrow(`Controller · ${esc(D.ctl.name)}`) + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${progRows.join("")}</table>`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>`
      + (suggestDelay ? `<td style="padding-right:4px"><a href="${APP}#calculator" style="display:block;text-align:center;padding:11px 0;border-radius:99px;background:${C.deep};color:#fff;font-weight:700;font-size:13.5px;text-decoration:none">Set a 48 h rain delay</a></td>` : "")
      + `<td style="padding-left:${suggestDelay ? 4 : 0}px"><a href="${APP}#calculator" style="display:block;text-align:center;padding:10px 0;border-radius:99px;background:#fff;border:1px solid #cdd5d0;color:${C.ink};font-weight:700;font-size:13.5px;text-decoration:none">Open TurfOps</a></td></tr></table>`
      + `<div style="font-size:12px;color:${C.mute};line-height:1.45;margin-top:8px">${who.calcAt ? `Calc numbers from the calculator as of ${md(dayKey(new Date(who.calcAt)))}. ` : ""}Buttons open TurfOps, where you confirm. Nothing changes from this email.</div>`);
  }

  // season
  const S = D.season, rDiff = S.rainYtd - S.rainAvg;
  const season = card(eyebrow("Season") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">`
    + row("Rain since Jan 1", `${S.rainYtd.toFixed(1)} in · ${Math.abs(rDiff).toFixed(1)} in ${rDiff >= 0 ? "above" : "below"} avg`, true)
    + row("Days &#8805;100&#176;F this year", `${S.hotYtd} · avg ${Math.round(S.hotAvg)}`)
    + (S.freeze ? row(esc(S.freeze.label), esc(S.freeze.value)) : "") + `</table>`);

  const subjectBits: Record<string, string> = { water: "Water today", hold: "Hold off, rain coming", watch: "Not yet, but soon", ok: "No water needed" };
  const wetSoon = D.fc ? D.fc.slice(0, 3).find((d) => d.rain >= 0.1) : null;
  const subject = `${wk(D.today)} ${md(D.today)} · ${subjectBits[D.level]}${D.level === "water" ? `: ${D.G.filter((x) => x.state === "water").map((x) => `${x.name} ${f2(x.run)} in behind`).join(", ")}` : wetSoon ? `, rain ${wetSoon.date === D.today ? "today" : wk(wetSoon.date)}` : ""}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;background:${C.soft};font-family:Montserrat,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden">${esc(D.head)}. ${esc(D.reason)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft}"><tr><td align="center" style="padding:14px 10px 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:2px 4px 12px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td>${LOGO}</td><td style="padding-left:10px"><div style="font-size:15px;font-weight:700">TurfOps</div><div style="font-size:12px;color:${C.mute}">${wkLong(D.today)}, ${md(D.today)}</div></td></tr></table></td></tr>
${hero}${yesterday}${week}${fcHtml}${ctlHtml}${season}
<tr><td align="center" style="font-size:11px;color:${C.mute};line-height:1.6;padding-top:4px">TurfOps daily digest · <a href="${APP}" style="color:${C.green}">turf.eckerthaus.com</a><br>Change the send time or turn this off in TurfOps → gear menu → Notifications</td></tr>
</table></td></tr></table></body></html>`;

  const text = [`TURFOPS · ${wkLong(D.today)}, ${md(D.today)}`, "", `${D.head.toUpperCase()}`, D.reason,
    ...D.G.map((x) => `  ${x.name}: ${f2(x.run)} in behind (irrigate at ${f2(x.T)})`), "",
    `YESTERDAY (${md(D.yest)})`, wy ? `  High ${Math.round(n(wy.temp_high_f) ?? 0)} / low ${Math.round(n(wy.temp_low_f) ?? 0)} F, rain ${f2(n(wy.rain_in))} in, ET0 ${f2(n(wy.et0_in))} in` : "  No weather row yet.",
    ...D.ranY.map((r) => `  ${r.name} ran: ${r.zones}, ${r.mins}`), ...D.ranT.map((r) => `  ${r.name} ran this morning: ${r.zones}, ${r.mins}`),
    "", "WEEK", ...D.G.map((x) => `  ${x.name}: got ${f2(x.wGot)}, needed ${f2(x.wNeed)}`),
    ...(D.fc ? ["", "RAIN FORECAST", "  " + D.fc.map((d) => `${wk(d.date)} ${f2(d.rain)} (${d.pop}%)`).join(" · ")] : []),
    ...(D.ctl ? ["", `CONTROLLER (${D.ctl.name})`, ...D.ctl.programs.filter((p) => p.enabled).map((p) => `  ${p.name}: ${p.budget}%`), `  Rain delay: ${D.ctl.delayLeft ? D.ctl.delayLeft + " h left" : "none"}`] : []),
    "", APP].join("\n");

  // push: one line, tap opens TurfOps
  const pushTitle = D.level === "water" ? `Water today: ${D.G.filter((x) => x.state === "water").map((x) => `${x.name} ${f2(x.run)} in behind`).join(", ")}`
    : D.level === "hold" ? "Hold off, rain is coming" : D.level === "watch" ? "Not yet, but soon" : "No water needed today";
  const pushBody = D.level === "water" ? (D.rain48 != null ? (D.rain48 >= 0.05 ? `${f2(D.rain48)} in of rain in the next 2 days. Tap to review budgets.` : "No rain in the next 2 days. Tap to review budgets.") : "Tap to review budgets.")
    : D.level === "ok" ? `${D.reason}` : D.reason;
  const push = { title: pushTitle, body: plain(pushBody), url: D.level === "water" || D.level === "hold" ? `${APP}#calculator` : APP, tag: `turf-digest-${D.today}` };

  return { subject: plain(subject), html: safeHtml(html.replace(/>\s+</g, "><").replace(/\s*\n\s*/g, " ").trim()), text: plain(text), push };
}

/* ---------------- delivery ---------------- */
async function gmail(user: string, pass: string, to: string, mail: { subject: string; html: string; text: string }) {
  const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
  const c = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: user, password: pass } } });
  try { await c.send({ from: `TurfOps <${user}>`, to, subject: mail.subject, content: mail.text, html: mail.html }); } finally { await c.close(); }
}
async function sendMail(to: string, mail: { subject: string; html: string; text: string }) {
  // TurfOps' own Gmail (TURF_GMAIL_USER + TURF_GMAIL_APP_PASSWORD) wins; the band's senders are the fallback
  const tu = Deno.env.get("TURF_GMAIL_USER"), tp = Deno.env.get("TURF_GMAIL_APP_PASSWORD");
  if (tu && tp) { await gmail(tu, tp.replace(/\s+/g, ""), to, mail); return "gmail " + tu; }
  const rk = Deno.env.get("RESEND_API_KEY");
  if (rk) {
    const base = Deno.env.get("DIGEST_FROM") || "";
    const from = Deno.env.get("TURF_DIGEST_FROM") || (base ? base.replace(/^[^<]*</, "TurfOps <") : "TurfOps <onboarding@resend.dev>");
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${rk}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject: mail.subject, html: mail.html, text: mail.text }) });
    if (!r.ok) throw new Error(`Resend said ${r.status}: ${(await r.text()).slice(0, 200)}`); return "resend";
  }
  const user = Deno.env.get("GMAIL_USER"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (user && pass) {
    await gmail(user, pass, to, mail); return "gmail " + user;
  }
  throw new Error("No email sender set up (RESEND_API_KEY or GMAIL_USER + GMAIL_APP_PASSWORD).");
}

let vapidReady = false;
function vapid() {
  if (vapidReady) return true;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return false;
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:eckert.tyler@gmail.com", pub, priv);
  return (vapidReady = true);
}
async function pushTo(userId: string, payload: unknown) {
  if (!vapid()) throw new Error("VAPID keys are not set");
  const { data: subs } = await db.from("turfops_push_subs").select("endpoint,p256dh,auth").eq("user_id", userId);
  let sent = 0; const errs: string[] = [];
  for (const s of subs || []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" }); sent++; }
    catch (e: any) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.from("turfops_push_subs").delete().eq("endpoint", s.endpoint); else errs.push(String(e?.statusCode || e?.message || e)); }
  }
  return { devices: (subs || []).length, sent, errs };
}

async function deliver(D: Awaited<ReturnType<typeof gather>>, s: any, opts: { email: boolean; push: boolean }) {
  const out: Record<string, unknown> = { user: s.user_id };
  const msg = build(D, { calc: s.calc, calcAt: s.calc_at });
  if (opts.email && s.email_on) {
    let to = s.email;
    if (!to) { const { data } = await db.auth.admin.getUserById(s.user_id); to = data?.user?.email; }
    try { out.email = to ? `sent via ${await sendMail(to, msg)} to ${to}` : "no address"; } catch (e) { out.email = "failed: " + (e as Error).message; }
  }
  const alertOnly = s.push_mode === "alerts";
  if (opts.push && s.push_on) {
    if (alertOnly && D.level === "ok") out.push = "skipped (alerts only, nothing to do)";
    else { try { out.push = await pushTo(s.user_id, msg.push); } catch (e) { out.push = "failed: " + (e as Error).message; } }
  }
  return out;
}

/* ---------------- entry ---------------- */
async function member(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token); const u = data?.user; if (!u) return null;
  const { data: m } = await db.from("turfops_members").select("user_id").eq("user_id", u.id).maybeSingle();
  return m ? u : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("vapid")) return json({ key: Deno.env.get("VAPID_PUBLIC_KEY") || null });

    if (req.method === "POST") {
      const u = await member(req); if (!u) return json({ error: "Not a TurfOps member" }, 403);
      let body: any = {}; try { body = await req.json(); } catch (_) {}
      const { data: s } = await db.from("turfops_notify").select("*").eq("user_id", u.id).maybeSingle();
      const st = s || { user_id: u.id, email: u.email, email_on: true, push_on: true, push_mode: "daily" };
      const D = await gather();
      if (body.action === "preview") return json(build(D, { calc: st.calc, calcAt: st.calc_at }));
      if (body.action === "test") return json(await deliver(D, { ...st, push_mode: "daily" }, { email: body.email !== false, push: body.push !== false }));
      return json({ error: "Unknown action" }, 400);
    }

    // scheduled run
    const token = url.searchParams.get("token") || "";
    const { data: sec } = await db.from("turfops_secrets").select("digest_token").limit(1).maybeSingle();
    if (!sec || !/^[0-9a-f-]{36}$/i.test(token) || token !== String(sec.digest_token)) return new Response("Not found", { status: 404, headers: CORS });
    const force = !!url.searchParams.get("force"), now = new Date(), today = dayKey(now), hr = hourCT(now);
    const { data: all } = await db.from("turfops_notify").select("*");
    const members = new Set(((await db.from("turfops_members").select("user_id")).data || []).map((m: any) => m.user_id));
    const due = (all || []).filter((s: any) => members.has(s.user_id) && (s.email_on || s.push_on) && (force || (Number(s.send_hour ?? 6) === hr && s.last_sent_on !== today)));
    if (!due.length) return json({ due: 0, hour: hr });
    const D = await gather(), results = [];
    for (const s of due) {
      results.push(await deliver(D, s, { email: true, push: true }));
      await db.from("turfops_notify").update({ last_sent_on: today }).eq("user_id", s.user_id);
    }
    return json({ due: due.length, level: D.level, results });
  } catch (e) { console.error(e); return json({ error: (e as Error).message }, 500); }
});
