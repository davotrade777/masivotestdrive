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

// -------------------- Start --------------------
assertEnv();

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Masivo base URL: ${MASIVO_BASE_URL}`);
  console.log(`Masivo x-api-key: ${maskSecret(MASIVO_X_API_KEY)}`);
});
