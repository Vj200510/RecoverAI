/**
 * PayPal execution boundary tests.
 *
 * Proves that createRecoveryOrder() and captureRecoveryOrder() cannot
 * execute on already-completed or already-recovered transactions.
 *
 * These tests use the same in-memory DB mock pattern as problem9-boundary.ts.
 *
 * Run with:  tsx scripts/paypal-boundary.ts
 *
 * Tests:
 *   PAYPAL-BOUND-01  createRecoveryOrder blocked for SUCCESS transaction
 *   PAYPAL-BOUND-02  createRecoveryOrder blocked for RECOVERED transaction
 *   PAYPAL-BOUND-03  captureRecoveryOrder blocked for RECOVERED transaction
 *   PAYPAL-BOUND-04  captureRecoveryOrder returns alreadyCaptured for COMPLETED order
 *   PAYPAL-BOUND-05  captureRecoveryOrder returns alreadyCaptured when capture record exists
 *   PAYPAL-BOUND-06  analyzePayPalTransaction blocked for COMPLETED order
 *   PAYPAL-BOUND-07  createRecoveryOrder blocked when active order already exists
 */

import assert from "node:assert/strict";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/integrations/supabase/types.js";
import { AppError } from "../src/lib/db.server.js";

const WS: typeof WebSocket =
  typeof WebSocket !== "undefined" ? WebSocket : (NodeWebSocket as unknown as typeof WebSocket);

// ── In-memory DB for PayPal tables ────────────────────────────────────────────

function buildPayPalDb() {
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const customerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const transactionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const caseId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const paypalOrderId = "MOCK-ORDER-001";
  const captureId = "MOCK-CAP-001";

  const tables: Record<string, Array<Record<string, unknown>>> = {
    transactions: [
      {
        id: transactionId,
        user_id: userId,
        customer_id: customerId,
        transaction_ref: "TXN-BOUNDARY-001",
        amount: 100,
        currency: "USD",
        status: "FAILED",
        failure_reason: "network_error",
        retry_count: 0,
        recovery_status: "eligible",
        occurred_at: new Date().toISOString(),
        payment_method: "card",
        checkout_status: "completed",
      },
    ],
    customers: [
      {
        id: customerId,
        user_id: userId,
        external_id: "CUS-TEST",
        name: "Test Customer",
        email: "test@example.com",
        opted_out: false,
        previous_success_count: 5,
        previous_failure_count: 1,
        lifetime_value: 500,
        risk_level: "low",
      },
    ],
    paypal_orders: [] as Array<Record<string, unknown>>,
    paypal_captures: [] as Array<Record<string, unknown>>,
    recovery_cases: [],
    audit_events: [],
  };

  const db = createClient<Database>("http://test.invalid", "test-only-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WS },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const table = url.pathname.split("/").at(-1)!;
        const method = (init?.method ?? "GET").toUpperCase();

        const rows = tables[table] ?? [];

        const matches = (row: Record<string, unknown>) =>
          [...url.searchParams].every(([k, v]) => {
            if (!v.startsWith("eq.") && !v.startsWith("neq.") && !v.startsWith("in.")) return true;
            if (v.startsWith("eq.")) return String(row[k]) === v.slice(3);
            if (v.startsWith("neq.")) return String(row[k]) !== v.slice(4);
            if (v.startsWith("in.")) {
              const vals = v.slice(3).replace(/[()]/g, "").split(",");
              return vals.includes(String(row[k]));
            }
            return true;
          });

        let selected = rows.filter(matches);

        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          const newRow = { id: crypto.randomUUID(), ...body };
          rows.push(newRow);
          selected = [newRow];
          tables[table] = rows;
        } else if (method === "PATCH") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          selected.forEach((row) => Object.assign(row, body));
        }

        // Join paypal_orders with transactions
        if (table === "paypal_orders" && url.searchParams.get("select")?.includes("transactions")) {
          selected = selected.map((order) => ({
            ...order,
            transactions: tables["transactions"]!.find((t) => t["id"] === order["transaction_id"]),
          }));
        }

        const single = new Headers(init?.headers).get("Accept")?.includes("vnd.pgrst.object");
        return new Response(JSON.stringify(single ? (selected[0] ?? null) : selected), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  });

  return { db, userId, customerId, transactionId, caseId, paypalOrderId, captureId, tables };
}

// ── Mock PayPal HTTP calls ────────────────────────────────────────────────────

// eslint-disable-next-line prefer-const -- reassigned inside async test closures
let mockPayPalOrderStatus = "APPROVED";
const originalFetch = globalThis.fetch;

function mockPayPal() {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(typeof input === "string" ? input : (input as Request).url);

    if (url.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (
      url.includes("/v2/checkout/orders") &&
      !url.includes("/capture") &&
      init?.method !== "POST"
    ) {
      return new Response(
        JSON.stringify({
          id: "MOCK-ORDER-001",
          status: mockPayPalOrderStatus,
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: "USD", value: "100.00" } }],
          links: [
            {
              href: "https://sandbox.paypal.com/approve?token=MOCK-ORDER-001",
              rel: "approve",
              method: "GET",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (
      url.includes("/v2/checkout/orders") &&
      init?.method === "POST" &&
      !url.includes("/capture")
    ) {
      return new Response(
        JSON.stringify({
          id: "MOCK-ORDER-NEW",
          status: "CREATED",
          intent: "CAPTURE",
          purchase_units: [{ amount: { currency_code: "USD", value: "100.00" } }],
          links: [{ href: "https://sandbox.paypal.com/approve", rel: "approve", method: "GET" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/capture") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: "MOCK-ORDER-001",
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: "MOCK-CAP-001",
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "100.00" },
                    final_capture: true,
                  },
                ],
              },
            },
          ],
          links: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("auth/v1/settings")) {
      return new Response(JSON.stringify({ disable_signup: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected mock call: " + url }), { status: 404 });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// Set required PayPal env vars
process.env["PAYPAL_CLIENT_ID"] = "mock-client-id";
process.env["PAYPAL_CLIENT_SECRET"] = "mock-client-secret";
process.env["PAYPAL_BASE_URL"] = "https://api-m.sandbox.paypal.com";

mockPayPal();

const { createRecoveryOrder, captureRecoveryOrder, analyzePayPalTransaction } =
  await import("../src/lib/paypal-recovery.server.js");

let passed = 0;
let failed = 0;

async function check(id: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${id}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${id}:`, err instanceof Error ? err.message : err);
  }
}

// ── PAYPAL-BOUND-01: createRecoveryOrder blocked for SUCCESS ──────────────────
await check("PAYPAL-BOUND-01 createRecoveryOrder blocked for SUCCESS transaction", async () => {
  const f = buildPayPalDb();
  f.tables["transactions"]![0]!["status"] = "SUCCESS";
  await assert.rejects(
    () => createRecoveryOrder(f.db, f.userId, f.transactionId, "https://example.com"),
    (err) => {
      assert.ok(err instanceof AppError, "Expected AppError");
      assert.match(err.message, /already succeeded|SUCCESS/i);
      return true;
    },
  );
  assert.equal(f.tables["paypal_orders"]!.length, 0, "No PayPal orders should be created");
});

// ── PAYPAL-BOUND-02: createRecoveryOrder blocked for RECOVERED ────────────────
await check("PAYPAL-BOUND-02 createRecoveryOrder blocked for RECOVERED transaction", async () => {
  const f = buildPayPalDb();
  f.tables["transactions"]![0]!["status"] = "RECOVERED";
  await assert.rejects(
    () => createRecoveryOrder(f.db, f.userId, f.transactionId, "https://example.com"),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.match(err.message, /already succeeded|RECOVERED/i);
      return true;
    },
  );
  assert.equal(f.tables["paypal_orders"]!.length, 0);
});

// ── PAYPAL-BOUND-03: captureRecoveryOrder blocked for RECOVERED transaction ───
await check(
  "PAYPAL-BOUND-03 captureRecoveryOrder blocked when transaction is RECOVERED",
  async () => {
    const f = buildPayPalDb();
    // Seed a PayPal order linked to this transaction
    f.tables["paypal_orders"]!.push({
      id: "internal-order-id",
      user_id: f.userId,
      paypal_order_id: "MOCK-ORDER-001",
      transaction_id: f.transactionId,
      case_id: null,
      amount: 100,
      currency: "USD",
      status: "APPROVED",
    });
    // Mark transaction as already recovered
    f.tables["transactions"]![0]!["status"] = "RECOVERED";

    mockPayPalOrderStatus = "APPROVED";
    await assert.rejects(
      () => captureRecoveryOrder(f.db, f.userId, "MOCK-ORDER-001"),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.match(err.message, /already|RECOVERED|SUCCESS/i);
        return true;
      },
    );
    assert.equal(f.tables["paypal_captures"]!.length, 0, "No captures for recovered transaction");
  },
);

// ── PAYPAL-BOUND-04: captureRecoveryOrder idempotent for COMPLETED order ──────
await check(
  "PAYPAL-BOUND-04 captureRecoveryOrder returns alreadyCaptured for COMPLETED order",
  async () => {
    const f = buildPayPalDb();
    f.tables["paypal_orders"]!.push({
      id: "internal-order-id",
      user_id: f.userId,
      paypal_order_id: "MOCK-ORDER-001",
      transaction_id: f.transactionId,
      case_id: null,
      amount: 100,
      currency: "USD",
      status: "COMPLETED", // already done
    });
    f.tables["paypal_captures"]!.push({
      id: "internal-cap-id",
      user_id: f.userId,
      paypal_order_id: "MOCK-ORDER-001",
      paypal_capture_id: "MOCK-CAP-001",
      status: "COMPLETED",
      amount: 100,
      currency: "USD",
    });

    const result = await captureRecoveryOrder(f.db, f.userId, "MOCK-ORDER-001");
    assert.equal(result.alreadyCaptured, true);
    assert.equal(result.status, "COMPLETED");
    // Should NOT have created a new capture record
    assert.equal(f.tables["paypal_captures"]!.length, 1, "No new capture record created");
  },
);

// ── PAYPAL-BOUND-05: captureRecoveryOrder idempotent via existing capture ─────
await check(
  "PAYPAL-BOUND-05 captureRecoveryOrder idempotent when capture record exists",
  async () => {
    const f = buildPayPalDb();
    f.tables["paypal_orders"]!.push({
      id: "internal-order-id",
      user_id: f.userId,
      paypal_order_id: "MOCK-ORDER-001",
      transaction_id: f.transactionId,
      case_id: null,
      amount: 100,
      currency: "USD",
      status: "APPROVED",
    });
    // Capture already exists in DB
    f.tables["paypal_captures"]!.push({
      id: "internal-cap-id",
      user_id: f.userId,
      paypal_order_id: "MOCK-ORDER-001",
      paypal_capture_id: "EXISTING-CAP-001",
      status: "COMPLETED",
      amount: 100,
      currency: "USD",
    });

    mockPayPalOrderStatus = "APPROVED";
    const result = await captureRecoveryOrder(f.db, f.userId, "MOCK-ORDER-001");
    assert.equal(result.alreadyCaptured, true);
    assert.equal(result.captureId, "EXISTING-CAP-001");
    assert.equal(f.tables["paypal_captures"]!.length, 1, "No duplicate capture created");
  },
);

// ── PAYPAL-BOUND-06: analyzePayPalTransaction blocked for COMPLETED ───────────
await check(
  "PAYPAL-BOUND-06 analyzePayPalTransaction blocked for COMPLETED PayPal order",
  async () => {
    const f = buildPayPalDb();
    f.tables["paypal_orders"]!.push({
      id: "internal-order-id",
      user_id: f.userId,
      paypal_order_id: "MOCK-ORDER-001",
      transaction_id: f.transactionId,
      case_id: null,
      amount: 100,
      currency: "USD",
      status: "APPROVED",
    });

    // Make PayPal return COMPLETED status
    mockPayPalOrderStatus = "COMPLETED";

    const { DEFAULT_RULES } = await import("../src/lib/recovery-engine.js");
    await assert.rejects(
      () => analyzePayPalTransaction(f.db, f.userId, "MOCK-ORDER-001", DEFAULT_RULES),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.match(err.message, /COMPLETED|already|succeeded/i);
        return true;
      },
    );
    mockPayPalOrderStatus = "APPROVED";
  },
);

// ── PAYPAL-BOUND-07: createRecoveryOrder blocked when active order exists ──────
await check(
  "PAYPAL-BOUND-07 createRecoveryOrder blocked when active PayPal order exists",
  async () => {
    const f = buildPayPalDb();
    // Seed an existing active order
    f.tables["paypal_orders"]!.push({
      id: "existing-order-id",
      user_id: f.userId,
      paypal_order_id: "MOCK-ORDER-001",
      transaction_id: f.transactionId,
      case_id: null,
      amount: 100,
      currency: "USD",
      status: "APPROVED", // active
    });

    mockPayPalOrderStatus = "APPROVED";
    await assert.rejects(
      () => createRecoveryOrder(f.db, f.userId, f.transactionId, "https://example.com"),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.match(err.message, /already.*approval|active.*order/i);
        return true;
      },
    );
    assert.equal(f.tables["paypal_orders"]!.length, 1, "No second order created");
  },
);

restoreFetch();
console.log(`\nPayPal boundary tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
