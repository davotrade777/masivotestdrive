/**
 * Deduct (redeem) ALL points for a customer.
 *
 * Uses our proxy + purchase-with-redeem flow. Gets current balance,
 * then redeems that entire amount via a $0 purchase event.
 */

import "dotenv/config";
import fetchPkg from "node-fetch";

const fetchFn = globalThis.fetch ?? fetchPkg;

const API_URL = process.env.API_URL || "http://localhost:3000";
const CUSTOMER_ID = process.env.CUSTOMER_ID || process.env.customer_id;
const BRAND_ID = process.env.BRAND_ID || "0001";
const REWARD_ID = process.env.REWARD_ID || "67cd85fc-bbf7-4f58-a4e2-7ca6fc3e0438";

if (!CUSTOMER_ID) {
  console.error("Missing CUSTOMER_ID (or customer_id) in .env");
  process.exit(1);
}

/** Extract points from /api/me/customer response. Supports data.points or data.wallet.totals[]. */
function extractPoints(data) {
  if (!data) return null;
  if (data.points != null) return Number(data.points);
  const totals = data.wallet?.totals;
  if (Array.isArray(totals) && totals.length > 0) {
    const val = (t) => t?.balance ?? t?.amount ?? t?.points ?? t?.value ?? t?.total;
    const t0 = totals[0];
    const v = val(t0);
    if (v != null) return Number(v);
    for (const t of totals) {
      const type = String(t?.type ?? t?.currency ?? "").toUpperCase();
      if (type === "POINTS" && val(t) != null) return Number(val(t));
    }
  }
  return null;
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
  console.log("Deduct all points for customer:", CUSTOMER_ID);

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

  let code = totpReq.json?.data?.code;
  if (!code) code = await readStdinLine("Enter TOTP code: ");

  // 2) TOTP verify
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

  // 3) Get current points
  console.log("\n3) GET /api/me/customer (current balance)");
  const customerRes = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (!customerRes.ok) {
    console.error("Failed to get customer:", customerRes.status, customerRes.json || customerRes.text);
    process.exit(1);
  }

  const data = customerRes.json?.data;
  const currentPoints = extractPoints(data);
  if (currentPoints == null) {
    console.error("Could not read points from response:", customerRes.json);
    process.exit(1);
  }

  console.log("Current points:", currentPoints);

  if (currentPoints <= 0) {
    console.log("Nothing to deduct. Balance is already 0 or negative.");
    process.exit(0);
  }

  const pointsToDeduct = Math.floor(Number(currentPoints));
  console.log("Will deduct:", pointsToDeduct, "points");

  // 4) Redeem all points (purchase-with-redeem, order value 0)
  console.log("\n4) POST /api/behavior/events (redeem all points)");
  const redeemRes = await requestJson(
    "POST",
    "/api/behavior/events",
    {
      customer_id: String(CUSTOMER_ID).trim(),
      event_type: "PURCHASE",
      brand_id: String(BRAND_ID).trim(),
      order: {
        purchase_id: `deduct-all-${Date.now()}`,
        value: 0,
        products: [
          {
            sku: "deduct-all-points",
            quantity: 1,
            amount: 1,
            value: 0,
            redeem: [{ id: String(REWARD_ID).trim(), amount: pointsToDeduct }],
          },
        ],
        payment_method: "OTHER",
      },
    },
    { Authorization: `Bearer ${appToken}` }
  );

  if (!redeemRes.ok) {
    console.error("Deduction failed:", redeemRes.status, redeemRes.json || redeemRes.text);
    process.exit(1);
  }
  console.log("Points deducted successfully:", redeemRes.json);

  // 5) Confirm new balance
  console.log("\n5) GET /api/me/customer (balance after)");
  const afterRes = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (afterRes.ok) {
    const afterPoints = extractPoints(afterRes.json?.data);
    if (afterPoints != null) console.log("Points AFTER:", afterPoints);
  }
})();
