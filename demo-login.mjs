import "dotenv/config";
import fetchPkg from "node-fetch";

const fetchFn = globalThis.fetch ?? fetchPkg;

const API_URL = process.env.API_URL || "http://localhost:3000";
// acepta CUSTOMER_ID o customer_id
const CUSTOMER_ID = process.env.CUSTOMER_ID || process.env.customer_id;
const BRAND_ID = process.env.BRAND_ID || "0001";
const REWARD_ID = process.env.REWARD_ID || "67cd85fc-bbf7-4f58-a4e2-7ca6fc3e0438";

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

  // 5) POST behavior/events (PURCHASE example)
  console.log("\n5) POST /api/behavior/events (PURCHASE)");
  const eventsPayload = {
    customer_id: String(CUSTOMER_ID).trim(),
    event_type: "PURCHASE",
    brand_id: String(BRAND_ID).trim(),
    order: {
      purchase_id: `demo-${Date.now()}`,
      value: 10,
      products: [{ sku: "demo-product-1", quantity: 2, amount: 10, value: 10 }],
      payment_method: "OTHER",
    },
  };
  const events = await requestJson("POST", "/api/behavior/events", eventsPayload, {
    Authorization: `Bearer ${appToken}`,
  });

  if (!events.ok) {
    console.error("Behavior events failed:", events.status, events.json || events.text);
    process.exit(1);
  }

  console.log("Behavior events OK:\n", JSON.stringify(events.json, null, 2));

  // 6a) Check customer balance BEFORE redemption
  console.log("\n6a) GET /api/me/customer (check balance before redeem)");
  const customerBefore = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (customerBefore.ok && customerBefore.json?.data?.points) {
    console.log("Points balance BEFORE redeem:", customerBefore.json.data.points);
  }

  // 6b) PUT rewards/redeem/preview (preview redemption before actual redeem)
  console.log("\n6b) PUT /api/rewards/redeem/preview");
  const previewOrder = {
    order: {
      products: [
        {
          sku: "demo-product-1",
          amount: 10,
          value: 10,
          redeem: [
            {
              id: String(REWARD_ID).trim(), // Use "id" not "reward_id" in purchase events
              amount: 6, // Points to redeem at product level
            },
          ],
        },
      ],
      value: 10,
    },
  };
  const preview = await requestJson("PUT", "/api/rewards/redeem/preview", previewOrder, {
    Authorization: `Bearer ${appToken}`,
  });

  if (!preview.ok) {
    console.error("Rewards redeem preview failed:", preview.status, preview.json || preview.text);
    process.exit(1);
  }

  console.log("Rewards redeem preview OK:\n", JSON.stringify(preview.json, null, 2));

  // 6c) POST rewards/redeem (actual redemption - standalone)
  console.log("\n6c) POST /api/rewards/redeem (standalone)");
  const redeemPayload = {
    customer_id: String(CUSTOMER_ID).trim(),
    reward_id: String(REWARD_ID).trim(),
    amount: 100,
  };
  const redeem = await requestJson("POST", "/api/rewards/redeem", redeemPayload, {
    Authorization: `Bearer ${appToken}`,
  });

  if (!redeem.ok) {
    console.error("Rewards redeem failed:", redeem.status, redeem.json || redeem.text);
    process.exit(1);
  }

  console.log("Rewards redeem OK:\n", JSON.stringify(redeem.json, null, 2));

  // 6d) Check customer balance AFTER redemption
  console.log("\n6d) GET /api/me/customer (check balance after redeem)");
  const customerAfter = await requestJson("GET", "/api/me/customer", null, {
    Authorization: `Bearer ${appToken}`,
  });
  if (customerAfter.ok && customerAfter.json?.data?.points) {
    console.log("Points balance AFTER redeem:", customerAfter.json.data.points);
    if (customerBefore.ok && customerBefore.json?.data?.points) {
      const diff = customerBefore.json.data.points - customerAfter.json.data.points;
      console.log("Points deducted:", diff);
      if (diff === 0) {
        console.warn("⚠️  WARNING: No points were deducted! Redemption may need to be part of a purchase event.");
      }
    }
  }

  // 6e) Alternative: Redeem as part of a purchase event
  console.log("\n6e) POST /api/behavior/events (PURCHASE with redemption)");
  const purchaseWithRedeem = {
    customer_id: String(CUSTOMER_ID).trim(),
    event_type: "PURCHASE",
    brand_id: String(BRAND_ID).trim(),
    order: {
      purchase_id: `demo-redeem-${Date.now()}`,
      value: 10,
      products: [
        {
          sku: "demo-product-1",
          quantity: 1,
          amount: 10,
          value: 10,
          redeem: [
            {
              id: String(REWARD_ID).trim(), // Use "id" not "reward_id" in purchase events
              amount: 6, // Points to redeem
            },
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
    console.error("Purchase with redeem failed:", purchaseRedeem.status, purchaseRedeem.json || purchaseRedeem.text);
  } else {
    console.log("Purchase with redeem OK:\n", JSON.stringify(purchaseRedeem.json, null, 2));
    
    // Check balance after purchase with redeem
    console.log("\n6f) GET /api/me/customer (check balance after purchase+redeem)");
    const customerAfterPurchase = await requestJson("GET", "/api/me/customer", null, {
      Authorization: `Bearer ${appToken}`,
    });
    if (customerAfterPurchase.ok && customerAfterPurchase.json?.data?.points) {
      console.log("Points balance AFTER purchase+redeem:", customerAfterPurchase.json.data.points);
      if (customerAfter.ok && customerAfter.json?.data?.points) {
        const diff = customerAfter.json.data.points - customerAfterPurchase.json.data.points;
        console.log("Points deducted from purchase+redeem:", diff);
      }
    }
  }
})();
