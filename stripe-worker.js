/* =====================================================================
   STEADY & STRONG — payment guard
   ---------------------------------------------------------------------
   A page on its own cannot tell whether somebody really paid. It only
   sees them come back from Stripe, and anybody can type that address by
   hand. This little server sits between the two: Stripe tells it, in
   private, who paid for what, and the app asks it who is allowed in.

   It runs on Cloudflare Workers, which is free for this amount of work
   and needs no card. Setting it up takes about ten minutes — the steps
   are at the bottom of this file.
   ===================================================================== */

const PRODUCTS = {
  /* Match these to the Payment Links you created in Stripe.
     "days" is how long the access lasts after each payment. */
  monthly:   { days: 30,  plan: "monthly" },
  yearly:    { days: 365, plan: "yearly" },
  family:    { days: 30,  plan: "family",    seats: 4 },
  familybig: { days: 30,  plan: "familybig", seats: 8 },
  extras:    { days: 30,  plan: "extras" }
};

/* ---------- small helpers ---------- */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

/* Stripe signs every webhook. Without checking that signature anybody
   could post a fake "she paid" message to this address, which would put
   us right back where we started. */
async function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map(p => p.split("=").map(s => s.trim()))
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  /* refuse anything older than five minutes: stops a captured message
     being replayed later */
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const expected = [...new Uint8Array(mac)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  /* compare in constant time */
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

async function stripeApi(env, path, method = "GET", form = null) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form ? new URLSearchParams(form).toString() : undefined
  });
  return res.json();
}

/* ---------- what somebody is entitled to ---------- */

async function readEntitlement(env, email) {
  const raw = await env.SS.get(`ent:${email}`);
  return raw ? JSON.parse(raw) : null;
}

async function writeEntitlement(env, email, patch) {
  const now = Date.now();
  const current = (await readEntitlement(env, email)) || {
    email,
    plan: null,
    planExpiry: null,
    extras: false,
    extrasExpiry: null,
    familyCode: null,
    history: []
  };
  const next = { ...current, ...patch, updated: now };
  next.history = (current.history || []).slice(-19);
  await env.SS.put(`ent:${email}`, JSON.stringify(next));
  return next;
}

function familyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `FAM-${out}`;
}

/* ---------- the webhook: Stripe telling us about a payment ---------- */

async function handleWebhook(request, env) {
  const raw = await request.text();
  const ok = await verifyStripeSignature(
    raw,
    request.headers.get("stripe-signature"),
    env.STRIPE_WEBHOOK_SECRET
  );
  if (!ok) return json({ error: "bad signature" }, 400);

  const event = JSON.parse(raw);
  const obj = event.data && event.data.object;

  /* a payment went through */
  if (
    event.type === "checkout.session.completed" ||
    event.type === "invoice.payment_succeeded"
  ) {
    const email = normEmail(
      (obj.customer_details && obj.customer_details.email) ||
        obj.customer_email ||
        obj.email
    );
    if (!email) return json({ ok: true, note: "no email on this event" });

    /* which product? the Payment Link carries it in client_reference_id
       or in the metadata you set on the link */
    let key =
      (obj.metadata && obj.metadata.product) ||
      (obj.client_reference_id || "").split(":")[0];
    if (!PRODUCTS[key]) key = "monthly";

    const def = PRODUCTS[key];
    const until = Date.now() + def.days * 86400000;
    const patch =
      key === "extras"
        ? { extras: true, extrasExpiry: until, extrasSource: "paid" }
        : { plan: def.plan, planExpiry: until, paid: true };

    if (def.seats) {
      const existing = await readEntitlement(env, email);
      patch.familyCode = (existing && existing.familyCode) || familyCode();
      patch.seats = def.seats;
      /* the family record the app reads to count places */
      await env.SS.put(
        `fam:${patch.familyCode}`,
        JSON.stringify({
          code: patch.familyCode,
          plan: def.plan,
          seats: def.seats,
          ownerEmail: email,
          expiry: until,
          members: []
        })
      );
    }
    if (obj.customer) patch.customerId = obj.customer;

    const saved = await writeEntitlement(env, email, patch);
    saved.history.push({ key, at: Date.now(), amount: obj.amount_total || null });
    await env.SS.put(`ent:${email}`, JSON.stringify(saved));
    return json({ ok: true });
  }

  /* stopped paying, or the money was returned */
  if (
    event.type === "customer.subscription.deleted" ||
    event.type === "charge.refunded"
  ) {
    const email = normEmail(
      obj.customer_email || (obj.customer_details && obj.customer_details.email)
    );
    if (email) {
      await writeEntitlement(env, email, {
        paid: false,
        plan: null,
        planExpiry: null,
        extras: false,
        extrasExpiry: null
      });
    }
    return json({ ok: true });
  }

  return json({ ok: true, ignored: event.type });
}

/* ---------- the app asking: is this person allowed in? ---------- */

async function handleEntitlement(request, env) {
  const url = new URL(request.url);
  const email = normEmail(url.searchParams.get("email"));
  if (!email) return json({ error: "email needed" }, 400);

  const ent = await readEntitlement(env, email);
  if (!ent) {
    return json({ paid: false, plan: null, extras: false });
  }
  const now = Date.now();
  return json({
    paid: !!ent.paid && (!ent.planExpiry || ent.planExpiry > now),
    plan: ent.planExpiry && ent.planExpiry > now ? ent.plan : null,
    planExpiry: ent.planExpiry || null,
    extras: !!ent.extras && (!ent.extrasExpiry || ent.extrasExpiry > now),
    extrasExpiry: ent.extrasExpiry || null,
    familyCode: ent.familyCode || null,
    seats: ent.seats || null
  });
}

/* ---------- somebody wants to cancel or get their money back ---------- */

async function handlePortal(request, env) {
  const url = new URL(request.url);
  const email = normEmail(url.searchParams.get("email"));
  const back = url.searchParams.get("return") || env.SITE_URL || "";
  if (!email) return json({ error: "email needed" }, 400);

  const ent = await readEntitlement(env, email);
  let customerId = ent && ent.customerId;

  if (!customerId) {
    const found = await stripeApi(env, `customers?email=${encodeURIComponent(email)}&limit=1`);
    customerId = found.data && found.data[0] && found.data[0].id;
  }
  if (!customerId) return json({ error: "no customer" }, 404);

  const session = await stripeApi(env, "billing_portal/sessions", "POST", {
    customer: customerId,
    return_url: back
  });
  if (session.url) return json({ url: session.url });
  return json({ error: "portal failed", detail: session.error || null }, 500);
}

/* ---------- family places, counted where nobody can edit them ---------- */

async function handleFamily(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").toUpperCase();
  const memberId = url.searchParams.get("member");
  const raw = await env.SS.get(`fam:${code}`);
  if (!raw) return json({ error: "unknown code" }, 404);

  const rec = JSON.parse(raw);
  if (rec.expiry && Date.now() > rec.expiry) return json({ error: "expired" }, 410);

  if (memberId) {
    const already = rec.members.some(m => m.id === memberId);
    if (!already) {
      if (rec.members.length + 1 >= rec.seats) {
        return json({ error: "full", seats: rec.seats }, 409);
      }
      rec.members.push({ id: memberId, ts: Date.now() });
      await env.SS.put(`fam:${code}`, JSON.stringify(rec));
    }
  }
  return json({
    ok: true,
    plan: rec.plan,
    seats: rec.seats,
    used: rec.members.length + 1,
    expiry: rec.expiry
  });
}

/* ---------- routing ---------- */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    try {
      if (url.pathname === "/webhook" && request.method === "POST") {
        return handleWebhook(request, env);
      }
      if (url.pathname === "/entitlement") return handleEntitlement(request, env);
      if (url.pathname === "/portal") return handlePortal(request, env);
      if (url.pathname === "/family") return handleFamily(request, env);
      if (url.pathname === "/health") return json({ ok: true, ts: Date.now() });
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: "server error", detail: String(err) }, 500);
    }
  }
};

/* =====================================================================
   HOW TO PUT THIS UP — about ten minutes, no card needed
   ---------------------------------------------------------------------
   1. Go to dash.cloudflare.com → Workers & Pages → Create → Worker.
      Give it a name, for example steady-strong-pay. Deploy the empty one.

   2. Edit code → delete what is there → paste this whole file → Deploy.

   3. Storage: Workers & Pages → KV → Create namespace, name it SS.
      Then in the Worker: Settings → Bindings → Add → KV namespace,
      variable name SS, and pick the namespace you just made.

   4. Settings → Variables and Secrets, add three secrets:
        STRIPE_SECRET_KEY      sk_live_...   (Stripe → Developers → API keys)
        STRIPE_WEBHOOK_SECRET  whsec_...     (from step 5)
        SITE_URL               https://franciscoescadacarvalho-debug.github.io

   5. Stripe → Developers → Webhooks → Add endpoint:
        URL:    https://steady-strong-pay.<your-name>.workers.dev/webhook
        Events: checkout.session.completed, invoice.payment_succeeded,
                customer.subscription.deleted, charge.refunded
      Copy the signing secret it shows you into STRIPE_WEBHOOK_SECRET.

   6. On each Payment Link in Stripe: ... → Edit → Metadata →
        product = monthly | yearly | family | familybig | extras
      This is how the server knows what was bought.

   7. In index.html, near the top, put the Worker address into BUILT_IN:
        apiUrl: "https://steady-strong-pay.<your-name>.workers.dev"

   From that moment the app stops believing the address bar and starts
   asking this server instead. Typing ?unlock=yearly by hand does nothing.
   ===================================================================== */
