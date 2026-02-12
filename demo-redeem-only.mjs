import "dotenv/config";
import fetchPkg from "node-fetch";

const fetchFn = globalThis.fetch ?? fetchPkg;

const API_URL = process.env.API_URL || "http://localhost:3000";
const CUSTOMER_ID = process.env.CUSTOMER_ID || process.env.customer_id;
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
  const looksLikeHtml = (v) =>
    typeof v === "string" && (v.trimStart().startsWith("<!") || v.includes("</html>"));
  const bodyHtml = json?.raw != null ? String(json.raw) : text;
  return { ok: r.ok, status: r.status, json, text, isHtml: looksLikeHtml(bodyHtml) };
}

(async () => {
  console.log("API_URL:", API_URL);
  console.log("customer_id:", CUSTOMER_ID);
  console.log("reward_id:", REWARD_ID);
  console.log("redeem amount:", REDEEM_AMOUNT);

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

  // 3) POST /api/rewards/redeem (requires Authorization)
  console.log("\n3) POST /api/rewards/redeem");
  const redeemPayload = {
    customer_id: String(CUSTOMER_ID).trim(),
    reward_id: String(REWARD_ID).trim(),
    amount: REDEEM_AMOUNT,
  };
  const redeem = await requestJson("POST", "/api/rewards/redeem", redeemPayload, {
    Authorization: `Bearer ${appToken}`,
  });

  if (!redeem.ok) {
    console.error("Rewards redeem failed:", redeem.status, redeem.json || redeem.text);
    process.exit(1);
  }

  if (redeem.isHtml) {
    console.error("Rewards redeem returned HTML instead of JSON. Masivo often does this when:");
    console.error("  - CUSTOMER_ID is invalid or not a Masivo customer (e.g. UUID). Use the same ID as the full demo (e.g. 1716573314).");
    console.error("  - Redeem URL is wrong. Ensure MASIVO_REDEEM_BASE_URL=https://app.masivo.ai in .env.");
    process.exit(1);
  }

  console.log("Rewards redeem OK:\n", JSON.stringify(redeem.json, null, 2));
})();
