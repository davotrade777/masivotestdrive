import "dotenv/config";
import fetchPkg from "node-fetch";

const fetchFn = globalThis.fetch ?? fetchPkg;

const API_URL = process.env.API_URL || "http://localhost:3000";
// acepta CUSTOMER_ID o customer_id
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
  console.log("API_URL:", API_URL);
  console.log("customer_id:", CUSTOMER_ID);
  console.log("brand_id:", BRAND_ID);
  console.log("reward_id:", REWARD_ID);
  console.log("redeem amount (points to subtract):", REDEEM_AMOUNT);

  // 1) Request TOTP
  console.log("\n1) POST /auth/totp/request");
  const totpReq = await requestJson("POST", "/auth/totp/request", {
    customer_id: String(CUSTOMER_ID),
    metadata: {},
  });

  if (!totpReq.ok) {
    console.error("TOTP request failed:", totpReq.status, totpReq.json || totpReq.text);
    process.exit(1);
  }

  console.log("TOTP request OK:", totpReq.json);

  let code = totpReq.json?.data?.code;
  if (!code) code = await readStdinLine("Enter TOTP code: ");

  // 2) Verify => get app token
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
    console.error("Verify OK but no token:", verify.json);
    process.exit(1);
  }

  console.log("Verify OK. App JWT (first 20):", appToken.slice(0, 20) + "...");

  // 3) Call protected endpoint (payload)
  console.log("\n3) GET /api/me (protected)");
  const me = await requestJson("GET", "/api/me", null, {
    Authorization: `Bearer ${appToken}`,
  });

  if (!me.ok) {
    console.error("Protected call /api/me failed:", me.status, me.json || me.text);
    process.exit(1);
  }

  console.log("Protected OK (/api/me):\n", JSON.stringify(me.json, null, 2));

  // 4) Call protected endpoint (customer real)
  console.log("\n4) GET /api/me/customer (protected)");
  const meCustomer = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });

  if (!meCustomer.ok) {
    console.error("Protected call /api/me/customer failed:", meCustomer.status, meCustomer.json || meCustomer.text);
    process.exit(1);
  }

  console.log("Protected OK (/api/me/customer):\n", JSON.stringify(meCustomer.json, null, 2));

  // 5) Check balance BEFORE redeem (Masivo only deducts points when redeeming inside a PURCHASE event)
  console.log("\n5) GET /api/me/customer (balance before redeem)");
  const customerBefore = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (customerBefore.ok && customerBefore.json?.data?.points != null) {
    console.log("Points BEFORE:", customerBefore.json.data.points);
  }

  // 6) Redeem points via PURCHASE-with-redeem – order value 0 so we add 0 points, only subtract via redeem
  console.log("\n6) POST /api/behavior/events (PURCHASE with redemption – subtract " + REDEEM_AMOUNT + " points, order value 0)");
  const purchaseWithRedeem = {
    customer_id: String(CUSTOMER_ID).trim(),
    event_type: "PURCHASE",
    brand_id: String(BRAND_ID).trim(),
    order: {
      purchase_id: `demo-redeem-${Date.now()}`,
      value: 0,
      products: [
        {
          sku: "demo-redeem-only",
          quantity: 1,
          amount: 1,
          value: 0,
          redeem: [
            { id: String(REWARD_ID).trim(), amount: REDEEM_AMOUNT },
          ],
        },
      ],
      payment_method: "OTHER",
    },
  };
  const purchaseRedeem = await requestJson("POST", "/api/behavior/events", purchaseWithRedeem, {
    Authorization: `Bearer ${appToken}`,
  });

  if (!purchaseRedeem.ok) {
    console.error("Purchase-with-redeem failed:", purchaseRedeem.status, purchaseRedeem.json || purchaseRedeem.text);
    process.exit(1);
  }
  console.log("Purchase-with-redeem OK:\n", JSON.stringify(purchaseRedeem.json, null, 2));

  // 7) Check balance AFTER redeem
  console.log("\n7) GET /api/me/customer (balance after redeem)");
  const customerAfter = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (customerAfter.ok && customerAfter.json?.data?.points != null) {
    console.log("Points AFTER:", customerAfter.json.data.points);
    if (customerBefore.ok && customerBefore.json?.data?.points != null) {
      const diff = customerBefore.json.data.points - customerAfter.json.data.points;
      console.log("Points subtracted:", diff);
      if (diff === 0) {
        console.warn("⚠️  No points deducted. Check reward_id, REDEEM_AMOUNT, and Masivo campaign rules.");
      }
    }
  }
})();
