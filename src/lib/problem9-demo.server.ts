import { fail, writeAudit, type Db } from "./db.server";
import { verifyAndExecuteRecoveryAction } from "./action-verifier.server";
import type { MerchantRules } from "./recovery-engine";

/** Dedicated synthetic records, never an existing customer's payment. */
export async function runHallucinationDemo(db: Db, userId: string, rules: MerchantRules) {
  if (process.env["NODE_ENV"] !== "development") {
    fail("The synthetic Problem 9 fixture is available only in development.");
  }
  if (rules.max_retries < 1 || rules.max_interventions < 1 || rules.recovery_window_hours <= 0) {
    fail("Demo requires a policy that permits at least one retry within a valid recovery window.");
  }
  const customerId = crypto.randomUUID();
  const transactionId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const transactionRef = `PROBLEM9-${transactionId}`;
  const { error: customerError } = await db.from("customers").insert({
    id: customerId,
    user_id: userId,
    external_id: `PROBLEM9-${customerId}`,
    name: "Problem 9 synthetic customer",
    email: "problem9@example.invalid",
    opted_out: false,
    previous_success_count: 20,
    previous_failure_count: 0,
  });
  if (customerError) fail("Could not create the synthetic Problem 9 customer.");
  const { error: transactionError } = await db.from("transactions").insert({
    id: transactionId,
    user_id: userId,
    customer_id: customerId,
    transaction_ref: transactionRef,
    amount: 1,
    currency: "USD",
    payment_method: "card",
    status: "SUCCESS",
    retry_count: 0,
    occurred_at: new Date().toISOString(),
    failure_reason: "network_error",
    checkout_status: "completed",
    recovery_status: "none",
  });
  if (transactionError) fail("Could not create the synthetic Problem 9 transaction.");
  const { error: caseError } = await db.from("recovery_cases").insert({
    id: caseId,
    user_id: userId,
    transaction_id: transactionId,
    customer_id: customerId,
    amount_at_risk: 1,
    status: "open",
    stop_reason: null,
    retry_count: 0,
    reminder_count: 0,
    reengagement_count: 0,
    alt_method_count: 0,
    recommended_action: "SMART_RETRY",
  });
  if (caseError) fail("Could not create the synthetic Problem 9 case.");
  const { error: decisionError } = await db.from("ai_decisions").insert({
    user_id: userId,
    case_id: caseId,
    recommended_action: "SMART_RETRY",
    diagnosis: "Deliberately incorrect proposal for the Problem 9 evaluation.",
    reason: "Injected hallucination: retry despite authoritative SUCCESS.",
    recovery_probability: 97,
    confidence: 100,
    risk_level: "low",
    source: "hallucination_test",
  });
  if (decisionError) fail("Could not save the deliberately bad proposal.");
  await writeAudit(
    db,
    userId,
    [
      {
        event_type: "HALLUCINATION_TEST",
        case_id: caseId,
        transaction_ref: transactionRef,
        actor: "demo_controls",
        action: "SMART_RETRY",
        reason: "Injected SMART_RETRY against SUCCESS in an otherwise eligible open case.",
        result: "Synthetic fixture prepared; sending through the production verification boundary",
      },
    ],
    { required: true },
  );

  let executorCallCount = 0;
  const { verification, execution } = await verifyAndExecuteRecoveryAction(
    { db, userId, caseId, action: "SMART_RETRY", rules },
    () => {
      executorCallCount += 1;
    },
    { transaction_ref: transactionRef, customer_id: customerId },
  );
  const hasSuccess = verification.evidence.some(
    (fact) => fact.source === "transactions" && fact.field === "status" && fact.value === "SUCCESS",
  );
  if (
    verification.decision !== "BLOCK" ||
    !hasSuccess ||
    !verification.reason.includes("transaction is already SUCCESS") ||
    execution.executed ||
    executorCallCount !== 0
  ) {
    fail("Demo assertion failed: expected the SUCCESS contradiction and zero executor calls.");
  }
  await writeAudit(
    db,
    userId,
    [
      {
        event_type: "HALLUCINATION_TEST",
        case_id: caseId,
        transaction_ref: transactionRef,
        actor: "demo_controls",
        action: "SMART_RETRY",
        reason: verification.reason,
        result: JSON.stringify({ executorCallCount, execution: "NOT CALLED", verification }),
      },
    ],
    { required: true },
  );
  return {
    caseId,
    transactionRef,
    proposedAction: "SMART_RETRY" as const,
    executorCalled: executorCallCount > 0,
    executorCallCount,
    verification,
  };
}
