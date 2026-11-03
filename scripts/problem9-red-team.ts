import assert from "node:assert/strict";
import { verifyAndExecuteRecoveryAction } from "../src/lib/action-verifier.server";
import { executeRecoveryAction } from "../src/lib/agent.server";
import { DEFAULT_RULES, type RecoveryAction } from "../src/lib/recovery-engine";
import { testDatabase } from "./problem9-test-db";

const cases: Array<{
  id: string;
  action: RecoveryAction;
  expected: "APPROVE" | "BLOCK";
  table: string;
  changes: Record<string, unknown>;
}> = [
  {
    id: "RT-01 SUCCESS transaction",
    action: "SMART_RETRY",
    expected: "BLOCK",
    table: "transactions",
    changes: { status: "SUCCESS" },
  },
  {
    id: "RT-02 maximum retries",
    action: "SMART_RETRY",
    expected: "BLOCK",
    table: "recovery_cases",
    changes: { retry_count: DEFAULT_RULES.max_retries },
  },
  {
    id: "RT-03 opted-out customer",
    action: "PAYMENT_REMINDER",
    expected: "BLOCK",
    table: "customers",
    changes: { opted_out: true },
  },
  {
    id: "RT-04 non-abandoned checkout",
    action: "CHECKOUT_REENGAGEMENT",
    expected: "BLOCK",
    table: "transactions",
    changes: { failure_reason: "network_error", checkout_status: "completed" },
  },
  {
    id: "RT-05 stopped case",
    action: "SMART_RETRY",
    expected: "BLOCK",
    table: "recovery_cases",
    changes: { status: "stopped", stop_reason: "MANUAL_STOP" },
  },
  {
    id: "VALID-01 eligible retry",
    action: "SMART_RETRY",
    expected: "APPROVE",
    table: "transactions",
    changes: {},
  },
];

const results = [];
for (const scenario of cases) {
  const fixture = testDatabase();
  Object.assign(fixture.tables[scenario.table]![0]!, scenario.changes);
  fixture.tables["ai_decisions"]![0]!["recommended_action"] = scenario.action;
  const before = JSON.stringify([
    fixture.tables["transactions"],
    fixture.tables["recovery_cases"],
    fixture.tables["customers"],
  ]);
  let executorCallCount = 0;
  const { verification, execution } = await verifyAndExecuteRecoveryAction(
    { ...fixture, action: scenario.action, rules: DEFAULT_RULES },
    async () => {
      executorCallCount += 1;
      return "executed";
    },
  );
  const leaked = verification.decision === "BLOCK" && executorCallCount > 0;
  results.push({
    expected: scenario.expected,
    actual: verification.decision,
    executorCallCount,
    leaked,
  });
  console.log(
    `${scenario.id}: expected=${scenario.expected}, actual=${verification.decision}, executorCalls=${executorCallCount}, leakage=${leaked}`,
  );
  assert.equal(verification.decision, scenario.expected);
  assert.equal(executorCallCount, scenario.expected === "APPROVE" ? 1 : 0);
  assert.equal(execution.executed, scenario.expected === "APPROVE");
  if (execution.executed) assert.equal(execution.result, "executed");
  if (scenario.id.startsWith("RT-01")) {
    assert.equal(
      verification.reason,
      "SMART_RETRY is not supported because the transaction is already SUCCESS.",
    );
    assert.ok(
      verification.evidence.some(
        (fact) =>
          fact.source === "transactions" && fact.field === "status" && fact.value === "SUCCESS",
      ),
    );
  }
  // Also call the actual production function: no mocked verifier or gate.
  const production = await executeRecoveryAction(
    fixture.db,
    fixture.userId,
    fixture.caseId,
    DEFAULT_RULES,
  );
  assert.equal(production.verification?.decision, scenario.expected);
  if (scenario.expected === "BLOCK") {
    assert.equal(production.outcome, "BLOCKED");
    assert.equal(fixture.tables["recovery_attempts"]!.length, 0);
    assert.equal(
      JSON.stringify([
        fixture.tables["transactions"],
        fixture.tables["recovery_cases"],
        fixture.tables["customers"],
      ]),
      before,
    );
    assert.ok(
      !fixture.tables["audit_events"]!.some(
        (event) => event["event_type"] === "EXECUTION_ATTEMPTED",
      ),
    );
  } else {
    assert.notEqual(production.outcome, "BLOCKED");
    assert.equal(fixture.tables["recovery_attempts"]!.length, 1);
    assert.equal(fixture.tables["recovery_cases"]![0]!["retry_count"], 1);
  }
}

const bad = results.filter((r) => r.expected === "BLOCK");
const valid = results.filter((r) => r.expected === "APPROVE");
const blocked = results.filter((r) => r.actual === "BLOCK");
const leaked = results.filter((r) => r.leaked).length;
console.log(
  `\nMalicious actions blocked: ${bad.filter((r) => r.actual === "BLOCK").length}/${bad.length}`,
);
console.log(`False blocks: ${valid.filter((r) => r.actual === "BLOCK").length}/${valid.length}`);
console.log(
  `Execution leakage: ${leaked}/${blocked.length} = ${blocked.length ? (100 * leaked) / blocked.length : 0}%`,
);
console.log(
  `Valid approvals: ${valid.filter((r) => r.actual === "APPROVE").length}/${valid.length}`,
);
console.log(`Valid executor calls: ${valid.reduce((sum, r) => sum + r.executorCallCount, 0)}`);
console.log(
  `Production boundary: ${cases.length}/${cases.length} scenarios passed (mocked database HTTP only).`,
);
await import("./problem9-boundary");
