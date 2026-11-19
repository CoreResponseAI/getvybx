// VYBX website lead form ("Start your event" inquiries from the VYBX Live page).
// Runs as a Vercel Function inside the getvybx website project only.
// No database and no connection to the VYBX Live app: it validates the
// submission, filters spam, and emails the lead through Resend from the
// verified getvybx.com domain.
//
// Environment variables (Vercel project "getvybx"):
//   RESEND_API_KEY    required. A Resend key with "Sending access" only, limited to getvybx.com.
//   LEAD_TO           optional. Where leads go. Default: abdul@gocoreai.co
//   LEAD_FROM         optional. Default: VYBX Website <notifications@getvybx.com>
//   TURNSTILE_SECRET  optional. If set, a valid Cloudflare Turnstile token is required.

const ALLOWED_HOSTS = [/^(www\.)?getvybx\.com$/, /^getvybx(-[a-z0-9-]+)?\.vercel\.app$/, /^localhost(:\d+)?$/];
const SIZES = ["Under 100", "100–500", "500–2,000", "2,000+"];
const GUEST_LIST = ["", "Yes, in a spreadsheet", "Not yet", "Not sure"];
const MIN_FILL_MS = 3000;        // humans take longer than this to fill the form
const MAX_AGE_MS = 24 * 3600e3;  // stale or replayed page loads
const RATE = { windowMs: 10 * 60e3, max: 5 };
const hits = new Map();          // best-effort, per warm instance

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/[\r\n]+/g, " ");
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;

function hostOf(url) { try { return new URL(url).host; } catch { return ""; } }

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE.max;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const raw = typeof req.body === "string" ? req.body : "";
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, remoteip: ip || "" }),
  });
  const j = await r.json().catch(() => ({}));
  return j.success === true;
}

function reply(req, res, status, payload) {
  const wantsJson = String(req.headers.accept || "").includes("application/json");
  if (wantsJson) return res.status(status).json(payload);
  // No-JavaScript fallback: plain redirects
  res.setHeader("Location", payload.ok ? "/thanks/" : "/live/?form=error#pilot");
  return res.status(303).end();
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ ok: false, error: "Method not allowed" }); }

  // Same-site requests only
  const origin = hostOf(req.headers.origin || req.headers.referer || "");
  if (!ALLOWED_HOSTS.some((re) => re.test(origin))) return reply(req, res, 403, { ok: false, error: "Please submit the form from getvybx.com." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return reply(req, res, 429, { ok: false, error: "Too many requests. Please try again in a few minutes." });

  const b = await readBody(req);

  // Spam traps: hidden field must be empty; form must be filled at human speed
  const silentlyAccept = () => reply(req, res, 200, { ok: true });
  if (clean(b.company_website, 200)) return silentlyAccept();
  const started = Number(b.t);
  const age = Date.now() - started;
  if (!started || age < MIN_FILL_MS || age > MAX_AGE_MS) return silentlyAccept();

  if (!(await verifyTurnstile(clean(b["cf-turnstile-response"], 4096), ip))) {
    return reply(req, res, 400, { ok: false, error: "Please confirm you're not a robot and try again." });
  }

  const lead = {
    name: oneLine(b.name, 120),
    organization: oneLine(b.organization, 160),
    email: oneLine(b.email, 200),
    phone: oneLine(b.phone, 40),
    eventName: oneLine(b.event_name, 160),
    date: oneLine(b.event_date, 80),
    size: oneLine(b.attendance, 30),
    venue: oneLine(b.venue, 160),
    guestList: oneLine(b.guest_list, 40),
  };

  const errors = {};
  if (lead.name.length < 2) errors.name = "Please enter your name.";
  if (lead.organization.length < 2) errors.organization = "Please enter your organization.";
  if (!EMAIL_RE.test(lead.email)) errors.email = "Please enter a valid email address.";
  if (lead.phone && !/^[0-9+().\-\s]{7,40}$/.test(lead.phone)) errors.phone = "Please check the phone number.";
  if (lead.eventName.length < 2) errors.event_name = "Please enter your event's name.";
  if (lead.date.length < 2) errors.event_date = "Please enter an approximate date.";
  if (!SIZES.includes(lead.size)) errors.attendance = "Please choose an attendance range.";
  if (!GUEST_LIST.includes(lead.guestList)) errors.guest_list = "Please choose an option.";
  const linky = /https?:\/\/|www\./i;
  ["name", "organization", "eventName", "venue"].forEach((k) => { if (linky.test(lead[k])) errors[k === "eventName" ? "event_name" : k] = "Please remove links."; });
  if (Object.keys(errors).length) return reply(req, res, 422, { ok: false, error: "Please fix the highlighted fields.", errors });

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("lead: RESEND_API_KEY is not set");
    return reply(req, res, 503, { ok: false, error: "We couldn't send your request right now. Please email support@getvybx.com." });
  }

  const rows = [
    ["Name", lead.name], ["Organization", lead.organization], ["Email", lead.email], ["Phone", lead.phone || "—"],
    ["Event name", lead.eventName], ["Approximate date", lead.date], ["Expected attendance", lead.size],
    ["Venue", lead.venue || "—"], ["Guest list", lead.guestList || "—"], ["Page", "VYBX Live, Start your event (getvybx.com/live)"],
  ];
  const html = `<h2 style="font-family:sans-serif">New VYBX Live event inquiry</h2><table cellpadding="8" style="font-family:sans-serif;border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="color:#555;vertical-align:top"><b>${k}</b></td><td style="white-space:pre-wrap">${esc(v)}</td></tr>`).join("")}</table>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `lead-${lead.email}-${started}` },
      body: JSON.stringify({
        from: process.env.LEAD_FROM || "VYBX Website <notifications@getvybx.com>",
        to: [process.env.LEAD_TO || "abdul@gocoreai.co"],
        reply_to: lead.email,
        subject: `Start your event: ${lead.eventName} (${lead.organization})`,
        html, text,
        tags: [{ name: "source", value: "website_start_event" }],
      }),
    });
    if (!r.ok) {
      console.error("lead: Resend error", r.status, (await r.text()).slice(0, 300));
      return reply(req, res, 502, { ok: false, error: "We couldn't send your request right now. Please email support@getvybx.com." });
    }
  } catch (e) {
    console.error("lead: Resend request failed", e && e.message);
    return reply(req, res, 502, { ok: false, error: "We couldn't send your request right now. Please email support@getvybx.com." });
  }

  console.log("lead: sent", { org: lead.organization, size: lead.size });
  return reply(req, res, 200, { ok: true });
};
