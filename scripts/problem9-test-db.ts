import { createClient } from "@supabase/supabase-js";
import { WebSocket as NodeWebSocket } from "ws";
import type { Database } from "../src/integrations/supabase/types";
import { DEFAULT_RULES } from "../src/lib/recovery-engine";

type Row = Record<string, unknown>;

/** In-memory HTTP boundary only: real Supabase query builder and real app code run. */
export function testDatabase() {
  const userId = "11111111-1111-4111-8111-111111111111";
  const customerId = "22222222-2222-4222-8222-222222222222";
  const transactionId = "33333333-3333-4333-8333-333333333333";
  const caseId = "44444444-4444-4444-8444-444444444444";
  const tables: Record<string, Row[]> = {
    merchant_settings: [{ user_id: userId, ...DEFAULT_RULES }],
    customers: [
      {
        id: customerId,
        user_id: userId,
        opted_out: false,
        previous_success_count: 20,
        previous_failure_count: 0,
      },
    ],
    transactions: [
      {
        id: transactionId,
        user_id: userId,
        customer_id: customerId,
        transaction_ref: "TEST-1",
        status: "FAILED",
        amount: 100,
        currency: "USD",
        payment_method: "card",
        retry_count: 0,
        failure_reason: "network_error",
        checkout_status: "completed",
        occurred_at: new Date().toISOString(),
      },
    ],
    recovery_cases: [
      {
        id: caseId,
        user_id: userId,
        transaction_id: transactionId,
        customer_id: customerId,
        amount_at_risk: 100,
        status: "open",
        stop_reason: null,
        retry_count: 0,
        reminder_count: 0,
        reengagement_count: 0,
        alt_method_count: 0,
      },
    ],
    ai_decisions: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        user_id: userId,
        case_id: caseId,
        recommended_action: "SMART_RETRY",
        reason: "Forced test proposal",
        recovery_probability: 97,
      },
    ],
    recovery_attempts: [],
    audit_events: [],
  };
  const operations: Array<{ table: string; method: string }> = [];
  let failTable: string | undefined;
  let beforeRead: ((table: string) => void) | undefined;
  // Node ≤ 20 does not have a native WebSocket — supply the ws polyfill so the
  // supabase realtime client initialises without throwing.
  const WebSocketImpl =
    typeof WebSocket !== "undefined" ? WebSocket : (NodeWebSocket as unknown as typeof WebSocket);
  const db = createClient<Database>("http://test.invalid", "test-only-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocketImpl },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const table = url.pathname.split("/").at(-1)!;
        const method = init?.method ?? "GET";
        operations.push({ table, method });
        if (failTable === table)
          return new Response(JSON.stringify({ message: "Test source unavailable" }), {
            status: 503,
          });
        if (method === "GET") beforeRead?.(table);
        const rows = tables[table];
        if (!rows) throw new Error(`Unexpected test table: ${table}`);
        const matches = (row: Row) =>
          [...url.searchParams].every(
            ([key, value]) => !value.startsWith("eq.") || String(row[key]) === value.slice(3),
          );
        let selected = rows.filter(matches);
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as Row | Row[];
          selected = (Array.isArray(body) ? body : [body]).map((row) => ({
            id: crypto.randomUUID(),
            ...row,
          }));
          rows.push(...selected);
        } else if (method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as Row;
          selected.forEach((row) => Object.assign(row, body));
        } else if (method !== "GET") {
          throw new Error(`Unexpected test method: ${method}`);
        }
        if (
          table === "recovery_cases" &&
          url.searchParams.get("select")?.includes("transactions")
        ) {
          selected = selected.map((row) => ({
            ...row,
            transactions: tables["transactions"]!.find((tx) => tx["id"] === row["transaction_id"]),
            customers: tables["customers"]!.find((c) => c["id"] === row["customer_id"]),
          }));
        }
        const single = new Headers(init?.headers).get("Accept")?.includes("vnd.pgrst.object");
        return new Response(JSON.stringify(single ? (selected[0] ?? null) : selected), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  });
  return {
    db,
    userId,
    caseId,
    tables,
    operations,
    fail: (table: string) => {
      failTable = table;
    },
    beforeRead: (callback: (table: string) => void) => {
      beforeRead = callback;
    },
  };
}
