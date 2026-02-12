/**
 * DEMO: Redeem 100 points only
 *
 * --- Why we send a "0 purchase" ---
 *
 * Masivo only deducts points when you redeem *inside* a purchase. There is no
 * separate "subtract 100 points" API that actually works. So we must send a
 * purchase event that includes a redemption.
 *
 * But a real purchase *adds* points (e.g. $10 → +10 or +30 points). We want to
 * ONLY subtract 100, not add any. So we use a "fake" purchase:
 *
 *   - Order value = $0  →  Masivo adds 0 points (0 × points-per-dollar)
 *   - We attach "redeem 100 points" to that order  →  Masivo subtracts 100
 *
 * Net effect: −100 points. No purchase in the real world; we're just using
 * the only mechanism that deducts points, with the smallest possible "order"
 * so we don't add any.
 */

import "dotenv/config";
import fetchPkg from "node-fetch";

const fetchFn = globalThis.fetch ?? fetchPkg;

const API_URL = process.env.API_URL || "http://localhost:3000";
const CUSTOMER_ID = process.env.CUSTOMER_ID || process.env.customer_id;
const BRAND_ID = process.env.BRAND_ID || "0001";
const REWARD_ID = process.env.REWARD_ID || "67cd85fc-bbf7-4f58-a4e2-7ca6fc3e0438";
const REDEEM_AMOUNT = Number(process.env.REDEEM_AMOUNT) || 100;

if (!CUSTOMER_ID) {
  console.error("Missing CUSTOMER_ID (or customer_id) in .env");
  process.exit(1);
}

async function readStdinLine(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => resolve(String(data).trim()));
  });
}

async function requestJson(method, path, body, headers = {}) {
  const r = await fetchFn(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

(async () => {
  console.log("--- Redeem " + REDEEM_AMOUNT + " points only ---");
  console.log("API_URL:", API_URL, "| customer_id:", CUSTOMER_ID, "| reward_id:", REWARD_ID);

  // 1) TOTP request
  console.log("\n1) POST /auth/totp/request");
  const totpReq = await requestJson("POST", "/auth/totp/request", {
    customer_id: String(CUSTOMER_ID),
    metadata: {},
  });
  if (!totpReq.ok) {
    console.error("TOTP request failed:", totpReq.status, totpReq.json || totpReq.text);
    process.exit(1);
  }
  console.log("TOTP OK");

  let code = totpReq.json?.data?.code;
  if (!code) code = await readStdinLine("Enter TOTP code: ");

  // 2) Verify → app token
  console.log("\n2) POST /auth/totp/verify");
  const verify = await requestJson("POST", "/auth/totp/verify", {
    customer_id: String(CUSTOMER_ID),
    code: String(code),
  });
  if (!verify.ok) {
    console.error("TOTP verify failed:", verify.status, verify.json || verify.text);
    process.exit(1);
  }
  const appToken = verify.json?.token;
  if (!appToken) {
    console.error("Verify OK but no token");
    process.exit(1);
  }
  console.log("Verify OK, got JWT");

  // 3) Balance before
  console.log("\n3) GET /api/me/customer (balance before)");
  const before = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (before.ok && before.json?.data?.points != null) {
    console.log("Points BEFORE:", before.json.data.points);
  }

  // 4) Redeem 100 points (0‑value “purchase” + redeem — see file header)
  console.log("\n4) POST /api/behavior/events (redeem " + REDEEM_AMOUNT + " pts, order value 0)");
  const redeem = await requestJson(
    "POST",
    "/api/behavior/events",
    {
      customer_id: String(CUSTOMER_ID).trim(),
      event_type: "PURCHASE",
      brand_id: String(BRAND_ID).trim(),
      order: {
        purchase_id: `redeem-100-${Date.now()}`,
        value: 0,
        products: [
          {
            sku: "redeem-only",
            quantity: 1,
            amount: 1,
            value: 0,
            redeem: [{ id: String(REWARD_ID).trim(), amount: REDEEM_AMOUNT }],
          },
        ],
        payment_method: "OTHER",
      },
    },
    { Authorization: `Bearer ${appToken}` }
  );

  if (!redeem.ok) {
    console.error("Redeem failed:", redeem.status, redeem.json || redeem.text);
    process.exit(1);
  }
  console.log("Redeem OK");

  // 5) Balance after
  console.log("\n5) GET /api/me/customer (balance after)");
  const after = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (after.ok && after.json?.data?.points != null) {
    console.log("Points AFTER:", after.json.data.points);
    if (before.ok && before.json?.data?.points != null) {
      const diff = before.json.data.points - after.json.data.points;
      console.log("Points subtracted:", diff);
    }
  }
})();
