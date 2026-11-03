import assert from "node:assert/strict";
import {
  verifyRecoveryAction,
  verifyAndExecuteRecoveryAction,
  runVerifiedExecutor,
} from "../src/lib/action-verifier.server";
import { executeRecoveryAction } from "../src/lib/agent.server";
import { runHallucinationDemo } from "../src/lib/problem9-demo.server";
import { DEFAULT_RULES } from "../src/lib/recovery-engine";
import { testDatabase } from "./problem9-test-db";

const fixture = testDatabase();
fixture.tables["transactions"]![0]!["status"] = "SUCCESS";
const result = await verifyRecoveryAction({
  ...fixture,
  action: "SMART_RETRY",
  rules: DEFAULT_RULES,
});
assert.equal(result.decision, "BLOCK");
assert.match(result.reason, /transaction is already SUCCESS/);
assert.ok(
  result.evidence.some(
    (fact) => fact.source === "transactions" && fact.field === "status" && fact.value === "SUCCESS",
  ),
);
console.log("PASS real Supabase query result -> source-grounded SUCCESS block");

let checks = 1;
async function check(name: string, run: () => void | Promise<void>) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}

for (const table of ["recovery_cases", "merchant_settings"]) {
  await check(`${table} unavailable fails closed`, async () => {
    const f = testDatabase();
    f.fail(table);
    let calls = 0;
    const result = await verifyAndExecuteRecoveryAction(
      { ...f, action: "SMART_RETRY", rules: DEFAULT_RULES },
      () => {
        calls += 1;
      },
    );
    assert.equal(result.verification.decision, "BLOCK");
    assert.equal(calls, 0);
    assert.equal(result.execution.executed, false);
  });
}
await check("missing settings cannot fall back to permissive defaults", async () => {
  const f = testDatabase();
  f.tables["merchant_settings"] = [];
  assert.equal(
    (await verifyRecoveryAction({ ...f, action: "SMART_RETRY", rules: DEFAULT_RULES })).decision,
    "BLOCK",
  );
});
await check("malformed source date fails closed", async () => {
  const f = testDatabase();
  f.tables["transactions"]![0]!["occurred_at"] = "invalid-date";
  assert.equal(
    (await verifyRecoveryAction({ ...f, action: "SMART_RETRY", rules: DEFAULT_RULES })).decision,
    "BLOCK",
  );
});
await check("fresh merchant policy overrides stale caller rules", async () => {
  const f = testDatabase();
  f.tables["merchant_settings"]![0]!["max_retries"] = 0;
  const result = await executeRecoveryAction(f.db, f.userId, f.caseId, DEFAULT_RULES);
  assert.equal(result.outcome, "BLOCKED");
  assert.match(result.message, /retry limit of 0/);
  assert.equal(f.tables["recovery_attempts"]!.length, 0);
});
await check("transaction changed after initial read is blocked at the fresh boundary", async () => {
  const f = testDatabase();
  let reads = 0;
  f.beforeRead((table) => {
    if (table === "recovery_cases" && ++reads === 2)
      f.tables["transactions"]![0]!["status"] = "SUCCESS";
  });
  const result = await executeRecoveryAction(f.db, f.userId, f.caseId, DEFAULT_RULES);
  assert.equal(result.outcome, "BLOCKED");
  assert.match(result.message, /already SUCCESS/);
  assert.equal(f.tables["recovery_attempts"]!.length, 0);
  assert.ok(!f.operations.some((op) => op.method === "PATCH"));
});
await check("audit persistence failure prevents executor entry", async () => {
  const f = testDatabase();
  f.fail("audit_events");
  let calls = 0;
  await assert.rejects(
    () =>
      verifyAndExecuteRecoveryAction({ ...f, action: "SMART_RETRY", rules: DEFAULT_RULES }, () => {
        calls += 1;
      }),
    /audit could not be saved/,
  );
  assert.equal(calls, 0);
});
await check("approval audit precedes exactly one asynchronous executor call", async () => {
  const f = testDatabase();
  let calls = 0;
  const result = await verifyAndExecuteRecoveryAction(
    { ...f, action: "SMART_RETRY", rules: DEFAULT_RULES },
    async () => {
      assert.deepEqual(
        f.tables["audit_events"]!.map((e) => e["event_type"]),
        ["VERIFICATION_ATTEMPTED", "ACTION_GROUNDING_APPROVED"],
      );
      calls += 1;
      return 42;
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.execution.result, 42);
});
await check("unknown agent action cannot bypass the production gate", async () => {
  const f = testDatabase();
  f.tables["ai_decisions"]![0]!["recommended_action"] = "OVERRIDE_VERIFICATION";
  await assert.rejects(
    () => executeRecoveryAction(f.db, f.userId, f.caseId, DEFAULT_RULES),
    /not a permitted/,
  );
  assert.ok(!f.operations.some((op) => op.method !== "GET"));
});
await check("escalation is inside the same boundary", async () => {
  const f = testDatabase();
  f.tables["ai_decisions"]![0]!["recommended_action"] = "ESCALATE";
  const result = await executeRecoveryAction(f.db, f.userId, f.caseId, DEFAULT_RULES);
  assert.equal(result.outcome, "ESCALATED");
  assert.equal(f.tables["recovery_attempts"]!.length, 1);
  const events = f.tables["audit_events"]!.map((e) => e["event_type"]);
  assert.ok(events.indexOf("ACTION_GROUNDING_APPROVED") < events.indexOf("EXECUTION_ATTEMPTED"));
});
await check("terminal escalation cannot mutate recovery state", async () => {
  const f = testDatabase();
  f.tables["ai_decisions"]![0]!["recommended_action"] = "ESCALATE";
  f.tables["recovery_cases"]![0]!["status"] = "stopped";
  assert.equal(
    (await executeRecoveryAction(f.db, f.userId, f.caseId, DEFAULT_RULES)).outcome,
    "BLOCKED",
  );
  assert.ok(!f.operations.some((op) => op.method === "PATCH"));
  assert.equal(f.tables["recovery_attempts"]!.length, 0);
});
await check("gate spy detects leakage even if a gate lies about executed", () => {
  function probe(gate: typeof runVerifiedExecutor) {
    let calls = 0;
    gate({ decision: "BLOCK" }, () => {
      calls += 1;
    });
    return calls;
  }
  assert.equal(probe(runVerifiedExecutor), 0);
  const deliberatelyBrokenGate: typeof runVerifiedExecutor = (_verification, executor) => {
    executor();
    return { executed: false, result: undefined };
  };
  assert.equal(probe(deliberatelyBrokenGate), 1);
});
await check(
  "actual demo server function is isolated, repeatable, and measures zero calls",
  async () => {
    const f = testDatabase();
    const originalEnv = process.env["NODE_ENV"];
    const originalRecords = JSON.stringify([
      f.tables["transactions"]![0],
      f.tables["customers"]![0],
      f.tables["recovery_cases"]![0],
    ]);
    try {
      process.env["NODE_ENV"] = "development";
      for (let run = 0; run < 2; run += 1) {
        const demo = await runHallucinationDemo(f.db, f.userId, DEFAULT_RULES);
        assert.equal(demo.executorCallCount, 0);
        assert.equal(demo.executorCalled, false);
        assert.equal(demo.verification.decision, "BLOCK");
        assert.match(demo.verification.reason, /transaction is already SUCCESS/);
        const getFact = (source: string, field: string) =>
          demo.verification.evidence.find((e) => e.source === source && e.field === field)?.value;
        assert.equal(getFact("recovery_cases", "status"), "open");
        assert.equal(getFact("recovery_cases", "stop_reason"), null);
        assert.equal(getFact("customers", "opted_out"), false);
        assert.equal(getFact("transactions", "status"), "SUCCESS");
        assert.equal(getFact("transactions", "retry_count"), 0);
        assert.equal(
          (await executeRecoveryAction(f.db, f.userId, demo.caseId, DEFAULT_RULES)).outcome,
          "BLOCKED",
        );
      }
      assert.equal(f.tables["recovery_attempts"]!.length, 0);
      assert.equal(
        JSON.stringify([
          f.tables["transactions"]![0],
          f.tables["customers"]![0],
          f.tables["recovery_cases"]![0],
        ]),
        originalRecords,
      );
      process.env["NODE_ENV"] = "production";
      const before = f.operations.length;
      await assert.rejects(
        () => runHallucinationDemo(f.db, f.userId, DEFAULT_RULES),
        /only in development/,
      );
      assert.equal(f.operations.length, before);
    } finally {
      if (originalEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = originalEnv;
    }
  },
);
console.log(
  `Boundary integration checks: ${checks} passed (database HTTP mocked; no live Supabase claim).`,
);
