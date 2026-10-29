// Supabase Edge Function: bhyve-control
// Lets TurfOps push changes to the Orbit B-hyve controller on request (never automatically):
//   status       -> devices, rain delay, and each program's current budget
//   set_budgets  -> { changes: [{ program_id, budget }] }  sets the program "Budget" (10-200%)
//   rain_delay   -> { hours, device_id? }                   0 cancels; up to 168 h
// Auth: the caller's Supabase session (Authorization: Bearer <access token>) must belong to a row
// in public.turfops_admins. Every write is recorded in public.bhyve_control_log.
// Secrets: BHYVE_EMAIL, BHYVE_PASSWORD (already set for pull-byhve). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

const BHYVE_BASE = "https://api.orbitbhyve.com/v1";
const BHYVE_WS = "wss://api.orbitbhyve.com/v1/events";
const APP_ID = "Orbit Support Dashboard";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function whoIs(req: Request): Promise<{ userId: string | null; probe: boolean }> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return { userId: null, probe: false };
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!u.ok) return { userId: null, probe: false };
  const user = await u.json();
  const a = await fetch(`${SB_URL}/rest/v1/turfops_admins?select=user_id&user_id=eq.${user.id}`, { headers: sbHeaders });
  const rows = a.ok ? await a.json() : [];
  return { userId: rows.length ? user.id : null, probe: false };
}

async function bhyveLogin() {
  const email = Deno.env.get("BHYVE_EMAIL"), password = Deno.env.get("BHYVE_PASSWORD");
  if (!email || !password) throw new Error("Missing BHYVE_EMAIL / BHYVE_PASSWORD secrets");
  const r = await fetch(`${BHYVE_BASE}/session`, {
    method: "POST", headers: { "Content-Type": "application/json", "orbit-app-id": APP_ID },
    body: JSON.stringify({ session: { email, password } }),
  });
  if (!r.ok) throw new Error(`B-hyve login failed (${r.status})`);
  const a = await r.json();
  const headers = { "orbit-api-key": a.orbit_api_key, "orbit-session-token": a.orbit_session_token || a.orbit_api_key, "orbit-app-id": APP_ID, "Content-Type": "application/json" };
  return { a, headers, token: a.orbit_session_token || a.orbit_api_key };
}

async function timers(h: Record<string, string>, userId: string) {
  const r = await fetch(`${BHYVE_BASE}/devices?user_id=${userId}`, { headers: h });
  if (!r.ok) throw new Error(`Could not list devices (${r.status})`);
  return ((await r.json()) as any[]).filter((d) => d.type === "sprinkler_timer");
}
async function programsOf(h: Record<string, string>, deviceId: string) {
  const r = await fetch(`${BHYVE_BASE}/sprinkler_timer_programs?device_id=${deviceId}`, { headers: h });
  if (!r.ok) throw new Error(`Could not list programs (${r.status})`);
  return (await r.json()) as any[];
}
const cleanProgram = (p: any) => ({
  id: p.id, device_id: p.device_id, name: p.name ?? null, program: p.program ?? null, budget: p.budget ?? null,
  enabled: p.enabled ?? null, is_smart_program: p.is_smart_program ?? null,
  stations: Array.isArray(p.run_times) ? p.run_times.map((t: any) => ({ station: t.station, run_time: t.run_time })) : [],
  start_times: p.start_times ?? null, frequency: p.frequency ?? null,
});
const cleanDevice = (d: any) => ({
  id: d.id, name: d.name ?? null, is_connected: d.is_connected ?? null,
  rain_delay: d.status?.rain_delay ?? 0, rain_delay_started_at: d.status?.rain_delay_started_at ?? null,
  run_mode: d.status?.run_mode ?? null, watering_status: d.status?.watering_status ? true : false,
});

async function status(h: Record<string, string>, userId: string) {
  const devs = await timers(h, userId);
  const out = [];
  for (const d of devs) out.push({ ...cleanDevice(d), programs: (await programsOf(h, d.id)).map(cleanProgram) });
  return { devices: out, at: new Date().toISOString() };
}

function sendWs(token: string, deviceId: string, msg: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BHYVE_WS);
    const t = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("B-hyve websocket timed out")); }, 8000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: "app_connection", orbit_session_token: token, subscribe_device_id: deviceId }));
      setTimeout(() => { ws.send(JSON.stringify(msg)); setTimeout(() => { clearTimeout(t); try { ws.close(); } catch (_) {} resolve("sent"); }, 1500); }, 700);
    };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error("B-hyve websocket error: " + ((e as any).message || "unknown"))); };
  });
}

async function log(userId: string | null, action: string, request: unknown, result: unknown, ok: boolean) {
  await fetch(`${SB_URL}/rest/v1/bhyve_control_log`, { method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: userId, action, request, result, ok }) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const who = await whoIs(req);
  if (!who.userId) return json({ error: "Not allowed to control the B-hyve controller" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch (_) {}
  const action = String(body.action || "status");

  try {
    const { a, headers, token } = await bhyveLogin();
    if (action === "status") return json(await status(headers, a.user_id));

    if (action === "set_budgets") {
      const changes = Array.isArray(body.changes) ? body.changes : [];
      if (!changes.length) return json({ error: "No changes" }, 400);
      const devs = await timers(headers, a.user_id), all: any[] = [];
      for (const d of devs) all.push(...(await programsOf(headers, d.id)));
      const results = [];
      for (const c of changes) {
        const prog = all.find((p) => p.id === c.program_id);
        const budget = Math.round(Number(c.budget));
        if (!prog) { results.push({ program_id: c.program_id, ok: false, error: "Program not found" }); continue; }
        if (!(budget >= 10 && budget <= 200)) { results.push({ program_id: c.program_id, ok: false, error: "Budget must be 10-200%" }); continue; }
        const before = prog.budget;
        const r = await fetch(`${BHYVE_BASE}/sprinkler_timer_programs/${prog.id}`, {
          method: "PUT", headers, body: JSON.stringify({ sprinkler_timer_program: { ...prog, budget } }),
        });
        const txt = await r.text();
        let after = null; try { after = JSON.parse(txt)?.budget ?? null; } catch (_) {}
        results.push({ program_id: prog.id, name: prog.name, program: prog.program, before, requested: budget, after, ok: r.ok, http: r.status, error: r.ok ? undefined : txt.slice(0, 300) });
      }
      const ok = results.every((x) => x.ok);
      await log(who.userId, "set_budgets", changes, results, ok);
      return json({ ok, results, status: await status(headers, a.user_id) }, ok ? 200 : 502);
    }

    if (action === "rain_delay") {
      const hours = Math.round(Number(body.hours));
      if (!(hours >= 0 && hours <= 168)) return json({ error: "Rain delay must be 0-168 hours" }, 400);
      const devs = await timers(headers, a.user_id);
      const targets = body.device_id ? devs.filter((d) => d.id === body.device_id) : devs;
      const results = [];
      for (const d of targets) {
        try {
          await sendWs(token, d.id, { event: "rain_delay", device_id: d.id, delay: hours, timestamp: new Date().toISOString() });
          await new Promise((r) => setTimeout(r, 1200));
          const r = await fetch(`${BHYVE_BASE}/devices/${d.id}`, { headers });
          const dev = r.ok ? await r.json() : null;
          const now = dev?.status?.rain_delay ?? null;
          results.push({ device_id: d.id, name: d.name, requested: hours, now, ok: now === hours || (hours === 0 && !now) });
        } catch (e) { results.push({ device_id: d.id, name: d.name, requested: hours, ok: false, error: String(e) }); }
      }
      const ok = results.length > 0 && results.every((x) => x.ok);
      await log(who.userId, "rain_delay", { hours, device_id: body.device_id ?? null }, results, ok);
      return json({ ok, results, status: await status(headers, a.user_id) }, ok ? 200 : 502);
    }
    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    if (action !== "status") await log(who.userId, action, body, { error: String(e) }, false);
    return json({ error: String(e) }, 500);
  }
});
