import "dotenv/config";
import express from "express";
import fetchPkg from "node-fetch";
import jwt from "jsonwebtoken";

const app = express();
app.use(express.json());

// -------------------- Config --------------------
const PORT = Number(process.env.PORT || 3000);

const MASIVO_BASE_URL =
  process.env.MASIVO_BASE_URL || "https://app.masivo.ai/api/storefront/v1";
const MASIVO_X_API_KEY = process.env.MASIVO_X_API_KEY;

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "2h";

// fetch fallback (Node < 18)
const fetchFn = globalThis.fetch ?? fetchPkg;

// -------------------- Helpers --------------------
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function maskSecret(s, left = 6, right = 4) {
  if (!s || typeof s !== "string") return String(s);
  if (s.length <= left + right) return "*".repeat(s.length);
  return `${s.slice(0, left)}...${s.slice(-right)}`;
}

function assertEnv() {
  if (!MASIVO_X_API_KEY) {
    console.error("FATAL: Missing MASIVO_X_API_KEY in .env");
    process.exit(1);
  }
  if (!UUID_RE.test(MASIVO_X_API_KEY)) {
    console.error(
      `FATAL: MASIVO_X_API_KEY must be UUID. Got: ${maskSecret(MASIVO_X_API_KEY)}`
    );
    process.exit(1);
  }
  if (!JWT_SECRET || JWT_SECRET.length < 16) {
    console.error("FATAL: Missing/weak JWT_SECRET (set a strong secret in .env)");
    process.exit(1);
  }
}

function decodeJwtExpMs(jwtStr) {
  try {
    const payloadB64 = jwtStr.split(".")[1];
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    if (!payload.exp) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

async function readResponseBody(r) {
  const text = await r.text().catch(() => "");
  if (!text) return { text: "", json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function logMasivoError(context, status, bodyText) {
  const snippet =
    bodyText && bodyText.length > 2000 ? bodyText.slice(0, 2000) + "..." : bodyText;
  console.error(
    `[MASIVO ERROR] ${context} -> status=${status} body=${snippet || "<empty>"}`
  );
}

// request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// -------------------- Masivo token cache --------------------
let cachedMasivoToken = null; // { token, expMs }

async function getMasivoAccessToken() {
  const now = Date.now();

  // reuse cached token (30s buffer)
  if (
    cachedMasivoToken?.token &&
    cachedMasivoToken?.expMs &&
    cachedMasivoToken.expMs - 30_000 > now
  ) {
    return cachedMasivoToken.token;
  }

  const r = await fetchFn(`${MASIVO_BASE_URL}/auth/authorize`, {
    method: "GET",
    headers: { "x-api-key": MASIVO_X_API_KEY },
  });

  const { text, json } = await readResponseBody(r);

  if (!r.ok) {
    logMasivoError("GET /auth/authorize", r.status, text);
    throw new Error(`Masivo authorize failed: ${r.status}`);
  }

  const token = json?.data;
  if (!token || typeof token !== "string") {
    logMasivoError("GET /auth/authorize (bad shape)", r.status, text);
    throw new Error("Masivo authorize: invalid response shape (expected { data: <token> })");
  }

  cachedMasivoToken = {
    token,
    expMs: decodeJwtExpMs(token) || Date.now() + 10 * 60 * 1000,
  };

  return token;
}

async function masivoFetch(path, init = {}) {
  const url = `${MASIVO_BASE_URL}${path}`;
  const token = await getMasivoAccessToken();

  const doFetch = (bearer) =>
    fetchFn(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${bearer}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });

  let r = await doFetch(token);

  // refresh once if 401
  if (r.status === 401) {
    cachedMasivoToken = null;
    const token2 = await getMasivoAccessToken();
    r = await doFetch(token2);
  }

  return r;
}

// -------------------- App JWT --------------------
function signAppJwt(customer_id) {
  return jwt.sign({ customer_id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const [type, token] = hdr.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing Authorization Bearer token" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { customer_id, iat, exp }
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// -------------------- Routes --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// Step 1: request totp
app.post("/auth/totp/request", async (req, res) => {
  try {
    const { customer_id, metadata = {} } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });

    const r = await masivoFetch("/auth/totp", {
      method: "POST",
      body: JSON.stringify({ customer_id, metadata }),
    });

    const { text, json } = await readResponseBody(r);

    if (!r.ok) {
      logMasivoError("POST /auth/totp", r.status, text);
      return res.status(r.status).json({
        error: "Masivo totp request failed",
        details: json || text,
      });
    }

    return res.status(200).json(json || { raw: text });
  } catch (e) {
    console.error("[SERVER ERROR] /auth/totp/request", e);
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
});

// Step 2: verify totp + issue app jwt
app.post("/auth/totp/verify", async (req, res) => {
  try {
    const { customer_id, code } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!code) return res.status(400).json({ error: "code is required" });

    const r = await masivoFetch(
      `/auth/totp/verify?code=${encodeURIComponent(String(code))}`,
      { method: "GET" }
    );

    const { text, json } = await readResponseBody(r);

    if (!r.ok) {
      logMasivoError("GET /auth/totp/verify", r.status, text);
      return res.status(r.status).json({
        error: "Masivo totp verify failed",
        details: json || text,
      });
    }

    const token = signAppJwt(String(customer_id));
    return res.status(200).json({
      ok: true,
      token,
      expires_in: JWT_EXPIRES_IN,
      masivo_verify: json || { raw: text },
    });
  } catch (e) {
    console.error("[SERVER ERROR] /auth/totp/verify", e);
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
});

// Protected: jwt payload
app.get("/api/me", requireAuth, (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// ✅ NEW: Protected: fetch customer real from Masivo
app.get("/api/me/customer", requireAuth, async (req, res) => {
  try {
    const { customer_id } = req.user;

    const r = await masivoFetch(
      `/customers/${encodeURIComponent(String(customer_id))}`,
      { method: "GET" }
    );

    const { text, json } = await readResponseBody(r);

    if (!r.ok) {
      logMasivoError("GET /customers/{id}", r.status, text);
      return res.status(r.status).json({
        error: "Masivo get customer failed",
        details: json || text,
      });
    }

    return res.status(200).json(json || { raw: text });
  } catch (e) {
    console.error("[SERVER ERROR] /api/me/customer", e);
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
});

// Protected: proxy POST to Masivo behavior/events
app.post("/api/behavior/events", requireAuth, async (req, res) => {
  try {
    const { customer_id, event_type, amount, timestamp, brand_id, order: orderIn, purchase_id, payment_method } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!event_type) return res.status(400).json({ error: "event_type is required" });
    if (!brand_id) return res.status(400).json({ error: "brand_id is required" });

    const PAYMENT_METHODS = ["CREDIT", "DEBIT", "CASH", "BANK_TRANSFER", "OTHER"];

    // Masivo API expects "type" and "order" with purchase_id, value, products, payment_method.
    let order = null;
    if (orderIn != null && typeof orderIn === "object" && !Array.isArray(orderIn)) {
      order = orderIn;
    } else if (amount != null) {
      const n = Number(amount);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "amount must be a non‑negative number" });
      const pm = payment_method != null && PAYMENT_METHODS.includes(String(payment_method).toUpperCase())
        ? String(payment_method).toUpperCase() : "OTHER";
      order = {
        purchase_id: purchase_id != null ? String(purchase_id).trim() : `order-${Date.now()}`,
        value: Math.floor(n),
        products: [{ sku: "unknown", quantity: 1, amount: Math.floor(n), value: Math.floor(n) }],
        payment_method: pm,
      };
      if (timestamp != null && String(timestamp).trim()) order.timestamp = String(timestamp).trim();
    }
    if (!order) return res.status(400).json({ error: "order (or amount) is required for behavior/events" });

    const payload = {
      customer_id: String(customer_id).trim(),
      type: String(event_type).trim(),
      brand_id: String(brand_id).trim(),
      order,
    };

    if (process.env.NODE_ENV !== "production") {
      console.log("[behavior/events] outgoing payload:", JSON.stringify(payload));
    }

    const r = await masivoFetch("/behavior/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const { text, json } = await readResponseBody(r);

    if (!r.ok) {
      logMasivoError("POST /behavior/events", r.status, text);
      return res.status(r.status).json({
        error: "Masivo behavior/events failed",
        details: json || text,
      });
    }

    return res.status(200).json(json || { raw: text });
  } catch (e) {
    console.error("[SERVER ERROR] /api/behavior/events", e);
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
});

// Protected: proxy PUT to Masivo redeem/preview (preview/validate redemptions)
app.put("/api/rewards/redeem/preview", requireAuth, async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!order || typeof order !== "object") {
      return res.status(400).json({ error: "order is required and must be an object" });
    }

    const redeemBaseUrl = process.env.MASIVO_REDEEM_BASE_URL || MASIVO_BASE_URL;
    const endpointPath = "/redeem/preview";
    const fullUrl = `${redeemBaseUrl}${endpointPath}`;

    if (process.env.NODE_ENV !== "production") {
      console.log("[rewards/redeem/preview] outgoing order:", JSON.stringify(order, null, 2));
      console.log("[rewards/redeem/preview] calling:", fullUrl);
    }

    let r;
    if (redeemBaseUrl !== MASIVO_BASE_URL) {
      const token = await getMasivoAccessToken();
      r = await fetchFn(fullUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ order }),
      });
    } else {
      r = await masivoFetch(endpointPath, {
        method: "PUT",
        body: JSON.stringify({ order }),
      });
    }

    const { text, json } = await readResponseBody(r);

    if (!r.ok) {
      logMasivoError("PUT /redeem/preview", r.status, text);
      return res.status(r.status).json({
        error: "Masivo rewards/redeem preview failed",
        details: json || text,
      });
    }

    return res.status(200).json(json || { raw: text });
  } catch (e) {
    console.error("[SERVER ERROR] /api/rewards/redeem/preview", e);
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
});

// Protected: proxy POST to Masivo customers/{customer_id}/redeem
app.post("/api/rewards/redeem", requireAuth, async (req, res) => {
  try {
    const { customer_id, reward_id, amount } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!reward_id) return res.status(400).json({ error: "reward_id is required" });
    if (amount == null) return res.status(400).json({ error: "amount is required" });

    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    // Masivo API: customer_id goes in URL path, not body
    const customerIdStr = String(customer_id).trim();
    const payload = {
      reward_id: String(reward_id).trim(),
      amount: Math.floor(n),
    };

    // Masivo API endpoint: /customers/{customer_id}/redeem
    // If MASIVO_REDEEM_BASE_URL is set, use it; otherwise use MASIVO_BASE_URL
    // This allows redeem to use a different base URL if needed
    const redeemBaseUrl = process.env.MASIVO_REDEEM_BASE_URL || MASIVO_BASE_URL;
    const endpointPath = process.env.MASIVO_REDEEM_PATH || `/customers/${encodeURIComponent(customerIdStr)}/redeem`;
    const fullUrl = `${redeemBaseUrl}${endpointPath}`;

    if (process.env.NODE_ENV !== "production") {
      console.log("[rewards/redeem] outgoing payload:", JSON.stringify(payload));
      console.log("[rewards/redeem] calling:", fullUrl);
    }

    // If using a different base URL, fetch directly instead of masivoFetch
    // Otherwise use masivoFetch which uses MASIVO_BASE_URL
    let r;
    if (redeemBaseUrl !== MASIVO_BASE_URL) {
      const token = await getMasivoAccessToken();
      r = await fetchFn(fullUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    } else {
      r = await masivoFetch(endpointPath, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    const { text, json } = await readResponseBody(r);

    if (!r.ok) {
      logMasivoError(`POST /customers/${customerIdStr}/redeem`, r.status, text);
      
      // 404 suggests endpoint doesn't exist - might not be in storefront API
      if (r.status === 404) {
        return res.status(404).json({
          error: "Masivo rewards/redeem endpoint not found (404)",
          message: "The /customers/{id}/redeem endpoint may not be available in the storefront API, or may require a different base URL/path.",
          attempted_url: fullUrl,
          suggestion: "Check Masivo API documentation for the correct redeem endpoint path, or verify if this endpoint requires a different API version or authentication.",
          details: text && text.length < 500 ? text : (json || "HTML error page returned"),
        });
      }
      
      return res.status(r.status).json({
        error: "Masivo rewards/redeem failed",
        details: json || text,
      });
    }

    return res.status(200).json(json || { raw: text });
  } catch (e) {
    console.error("[SERVER ERROR] /api/rewards/redeem", e);
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
});

// -------------------- Start --------------------
assertEnv();

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Masivo base URL: ${MASIVO_BASE_URL}`);
  console.log(`Masivo x-api-key: ${maskSecret(MASIVO_X_API_KEY)}`);
});
