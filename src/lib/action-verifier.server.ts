import {
  ACTION_LIMITS,
  RECOVERY_ACTIONS,
  computeRecoveryProbability,
  evaluateStoppingRules,
  type CaseFeatures,
  type MerchantRules,
  type RecoveryAction,
  type RiskLevel,
} from "./recovery-engine";
import { z } from "zod";
import { writeAudit, type AuditInput, type Db } from "./db.server";

export interface VerificationEvidence {
  source: string;
  field: string;
  value: string | number | boolean | null;
}

export interface VerificationResult {
  decision: "APPROVE" | "BLOCK";
  action: RecoveryAction;
  evidence: VerificationEvidence[];
  reason: string;
  risk: RiskLevel;
  latency_ms: number;
}

export type ExecutionGateResult<T> =
  { executed: true; result: T } | { executed: false; result: undefined };

/**
 * The single execution decision boundary shared by production and tests.
 * A blocked verification cannot invoke the supplied executor callback.
 */
export function runVerifiedExecutor<T>(
  verification: Pick<VerificationResult, "decision">,
  executor: () => T,
): ExecutionGateResult<T> {
  if (verification.decision !== "APPROVE") {
    return { executed: false, result: undefined };
  }
  return { executed: true, result: executor() };
}

export interface GroundingSnapshot {
  case_id: string;
  case_status: string;
  retry_count: number;
  reminder_count: number;
  reengagement_count: number;
  alt_method_count: number;
  stop_reason: string | null;
  amount_at_risk: number;
  transaction_id: string;
  transaction_status: string;
  transaction_retry_count: number;
  failure_reason: string | null;
  checkout_status: string | null;
  occurred_at: string;
  customer_opted_out: boolean;
  previous_success_count: number;
  previous_failure_count: number;
}

const counterSchema = z.number().int().nonnegative();
const sourceSchema = z.object({
  id: z.string(),
  status: z.string(),
  retry_count: counterSchema,
  reminder_count: counterSchema,
  reengagement_count: counterSchema,
  alt_method_count: counterSchema,
  stop_reason: z.string().nullable(),
  amount_at_risk: z.number().finite().nonnegative(),
  recommended_action: z.string().nullable().optional().default(null),
  transactions: z.object({
    id: z.string(),
    status: z.string(),
    retry_count: counterSchema,
    transaction_ref: z.string(),
    amount: z.number().finite().nonnegative(),
    currency: z.string(),
    payment_method: z.string(),
    subscription_status: z.string().nullable().optional().default(null),
    failure_reason: z.string().nullable(),
    checkout_status: z.string().nullable(),
    occurred_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  }),
  customers: z.object({
    id: z.string(),
    opted_out: z.boolean(),
    previous_success_count: counterSchema,
    previous_failure_count: counterSchema,
  }),
});
type VerifiableCaseRow = z.infer<typeof sourceSchema>;
const rulesSchema = z.object({
  max_retries: counterSchema,
  recovery_window_hours: z.number().positive().finite(),
  max_interventions: z.number().int().positive(),
  min_recovery_probability: z.number().min(0).max(100),
  escalation_threshold_amount: z.number().positive().finite(),
});

const VERIFIER_SELECT =
  "id, status, retry_count, reminder_count, reengagement_count, alt_method_count, stop_reason, amount_at_risk, recommended_action, transactions!inner(id, transaction_ref, amount, currency, payment_method, subscription_status, status, retry_count, failure_reason, checkout_status, occurred_at), customers!inner(id, opted_out, previous_success_count, previous_failure_count)";

function evidence(snapshot: GroundingSnapshot, rules: MerchantRules): VerificationEvidence[] {
  return [
    { source: "transactions", field: "status", value: snapshot.transaction_status },
    { source: "transactions", field: "retry_count", value: snapshot.transaction_retry_count },
    { source: "transactions", field: "failure_reason", value: snapshot.failure_reason },
    { source: "transactions", field: "checkout_status", value: snapshot.checkout_status },
    { source: "transactions", field: "occurred_at", value: snapshot.occurred_at },
    { source: "customers", field: "opted_out", value: snapshot.customer_opted_out },
    { source: "recovery_cases", field: "status", value: snapshot.case_status },
    { source: "recovery_cases", field: "retry_count", value: snapshot.retry_count },
    { source: "recovery_cases", field: "reminder_count", value: snapshot.reminder_count },
    { source: "recovery_cases", field: "reengagement_count", value: snapshot.reengagement_count },
    { source: "recovery_cases", field: "alt_method_count", value: snapshot.alt_method_count },
    { source: "recovery_cases", field: "stop_reason", value: snapshot.stop_reason },
    { source: "merchant_settings", field: "max_retries", value: rules.max_retries },
    {
      source: "merchant_settings",
      field: "recovery_window_hours",
      value: rules.recovery_window_hours,
    },
    { source: "merchant_settings", field: "max_interventions", value: rules.max_interventions },
    {
      source: "merchant_settings",
      field: "min_recovery_probability",
      value: rules.min_recovery_probability,
    },
    {
      source: "customers",
      field: "previous_success_count",
      value: snapshot.previous_success_count,
    },
    {
      source: "customers",
      field: "previous_failure_count",
      value: snapshot.previous_failure_count,
    },
  ];
}

function isTerminalTransaction(status: string): boolean {
  return ["SUCCESS", "RECOVERED"].includes(status.toUpperCase());
}

function isActiveCase(status: string): boolean {
  return ["open", "in_progress"].includes(status.toLowerCase());
}

function hoursSince(occurredAt: string): number {
  return (Date.now() - Date.parse(occurredAt)) / 3_600_000;
}

/**
 * Deterministic, source-grounded rules. The model never participates in this decision.
 * This function is exported separately so the red-team suite can exercise the exact
 * production rules without mocking a database client.
 */
export function evaluateGrounding(
  snapshot: GroundingSnapshot,
  action: RecoveryAction,
  rules: MerchantRules,
): Omit<VerificationResult, "action" | "latency_ms"> {
  const facts = evidence(snapshot, rules);
  const failures: string[] = [];
  const transactionTerminal = isTerminalTransaction(snapshot.transaction_status);
  const activeCase = isActiveCase(snapshot.case_status);
  const elapsedHours = hoursSince(snapshot.occurred_at);
  const interventions =
    snapshot.retry_count +
    snapshot.reminder_count +
    snapshot.reengagement_count +
    snapshot.alt_method_count;

  if (!RECOVERY_ACTIONS.includes(action)) {
    failures.push("The proposed action is not in the server-side recovery action allowlist.");
  }

  if (action !== "NO_ACTION" && !activeCase) {
    failures.push(
      `Recovery case status is ${snapshot.case_status}; only open or in-progress cases may act.`,
    );
  }

  if (action !== "NO_ACTION" && snapshot.stop_reason) {
    failures.push(
      `Recovery is stopped by ${snapshot.stop_reason}; no further action is supported.`,
    );
  }

  if (action === "SMART_RETRY") {
    if (transactionTerminal) {
      failures.push(
        `SMART_RETRY is not supported because the transaction is already ${snapshot.transaction_status}.`,
      );
    }
    if (snapshot.customer_opted_out) {
      failures.push(
        "SMART_RETRY is not supported because the customer has opted out of recovery contact.",
      );
    }
    if (
      snapshot.retry_count >= rules.max_retries ||
      snapshot.transaction_retry_count >= rules.max_retries
    ) {
      failures.push(
        `SMART_RETRY is not supported because the retry limit of ${rules.max_retries} has been reached.`,
      );
    }
    if (elapsedHours > rules.recovery_window_hours) {
      failures.push(
        `SMART_RETRY is not supported because the recovery window expired after ${rules.recovery_window_hours} hours.`,
      );
    }
    if (interventions >= rules.max_interventions) {
      failures.push(
        `SMART_RETRY is not supported because the intervention budget of ${rules.max_interventions} is exhausted.`,
      );
    }
  }

  if (action === "PAYMENT_REMINDER") {
    if (transactionTerminal)
      failures.push(
        "PAYMENT_REMINDER is not supported because the transaction no longer requires recovery.",
      );
    if (snapshot.customer_opted_out)
      failures.push("PAYMENT_REMINDER is blocked because the customer has opted out.");
    if (snapshot.reminder_count >= ACTION_LIMITS.PAYMENT_REMINDER.max) {
      failures.push(
        `PAYMENT_REMINDER is not supported after ${ACTION_LIMITS.PAYMENT_REMINDER.max} reminders.`,
      );
    }
    if (elapsedHours > rules.recovery_window_hours)
      failures.push("PAYMENT_REMINDER is outside the configured recovery window.");
  }

  if (action === "ALTERNATE_PAYMENT_METHOD") {
    if (transactionTerminal)
      failures.push(
        "ALTERNATE_PAYMENT_METHOD is not supported because the transaction is no longer recoverable.",
      );
    if (snapshot.alt_method_count >= ACTION_LIMITS.ALTERNATE_PAYMENT_METHOD.max) {
      failures.push(
        `ALTERNATE_PAYMENT_METHOD is not supported after ${ACTION_LIMITS.ALTERNATE_PAYMENT_METHOD.max} suggestion.`,
      );
    }
  }

  if (action === "CHECKOUT_REENGAGEMENT") {
    if (
      snapshot.failure_reason !== "checkout_abandoned" ||
      snapshot.checkout_status !== "abandoned"
    ) {
      failures.push(
        "CHECKOUT_REENGAGEMENT requires an authoritative abandoned-checkout transaction.",
      );
    }
    if (snapshot.reengagement_count >= ACTION_LIMITS.CHECKOUT_REENGAGEMENT.max) {
      failures.push(
        `CHECKOUT_REENGAGEMENT is not supported after ${ACTION_LIMITS.CHECKOUT_REENGAGEMENT.max} attempts.`,
      );
    }
    if (snapshot.customer_opted_out)
      failures.push("CHECKOUT_REENGAGEMENT is blocked because the customer has opted out.");
  }

  if (action !== "NO_ACTION" && action !== "ESCALATE") {
    if (!["FAILED", "ABANDONED"].includes(snapshot.transaction_status)) {
      failures.push(`Transaction status ${snapshot.transaction_status} does not support recovery.`);
    }
    const features: CaseFeatures = {
      amount: snapshot.amount_at_risk,
      failure_reason: snapshot.failure_reason,
      retry_count: Math.max(snapshot.retry_count, snapshot.transaction_retry_count),
      reminder_count: snapshot.reminder_count,
      reengagement_count: snapshot.reengagement_count,
      alt_method_count: snapshot.alt_method_count,
      previous_success_count: snapshot.previous_success_count,
      previous_failure_count: snapshot.previous_failure_count,
      hours_since_failure: elapsedHours,
      opted_out: snapshot.customer_opted_out,
      status: snapshot.case_status as CaseFeatures["status"],
    };
    const stop = evaluateStoppingRules(features, computeRecoveryProbability(features), rules);
    if (stop) failures.push(`Existing recovery guardrail prohibits the action: ${stop}.`);
    if (action === "SMART_RETRY" && features.retry_count >= ACTION_LIMITS.SMART_RETRY.max) {
      failures.push("The hard smart-retry limit has been reached.");
    }
  }

  const decision = failures.length > 0 ? "BLOCK" : "APPROVE";
  const risk: RiskLevel =
    decision === "BLOCK" || snapshot.amount_at_risk >= rules.escalation_threshold_amount
      ? "high"
      : action === "SMART_RETRY" || action === "ALTERNATE_PAYMENT_METHOD"
        ? "medium"
        : "low";

  return {
    decision,
    evidence: facts,
    reason:
      failures[0] ??
      `${action} is supported by the latest transaction, customer, case, and merchant policy evidence.`,
    risk,
  };
}

function snapshotFromRow(row: VerifiableCaseRow): GroundingSnapshot {
  return {
    case_id: row.id,
    case_status: row.status,
    retry_count: Number(row.retry_count),
    reminder_count: Number(row.reminder_count),
    reengagement_count: Number(row.reengagement_count),
    alt_method_count: Number(row.alt_method_count),
    stop_reason: row.stop_reason,
    amount_at_risk: Number(row.amount_at_risk),
    transaction_id: row.transactions.id,
    transaction_status: row.transactions.status,
    transaction_retry_count: Number(row.transactions.retry_count),
    failure_reason: row.transactions.failure_reason,
    checkout_status: row.transactions.checkout_status,
    occurred_at: row.transactions.occurred_at,
    customer_opted_out: row.customers.opted_out,
    previous_success_count: row.customers.previous_success_count,
    previous_failure_count: row.customers.previous_failure_count,
  };
}

/** Fetches fresh authoritative state immediately before any executor can run. */
export async function verifyRecoveryAction(input: {
  db: Db;
  userId: string;
  caseId: string;
  action: RecoveryAction;
  rules: MerchantRules;
}): Promise<VerificationResult> {
  return (await inspectRecoveryAction(input)).verification;
}

interface VerifiedSources {
  record: VerifiableCaseRow;
  rules: MerchantRules;
}

async function inspectRecoveryAction(input: Parameters<typeof verifyRecoveryAction>[0]): Promise<{
  verification: VerificationResult;
  source?: VerifiedSources;
}> {
  const started = Date.now();
  const { db, userId, caseId, action } = input;
  try {
    // Never treat a missing/error policy read as permission to use stale defaults.
    const [caseResult, policyResult] = await Promise.all([
      db
        .from("recovery_cases")
        .select(VERIFIER_SELECT)
        .eq("user_id", userId)
        .eq("id", caseId)
        .maybeSingle(),
      db.from("merchant_settings").select("*").eq("user_id", userId).maybeSingle(),
    ]);
    if (caseResult.error || policyResult.error) throw new Error("Source unavailable");
    const row = sourceSchema.parse(caseResult.data);
    const rules = rulesSchema.parse(policyResult.data);
    const result = evaluateGrounding(snapshotFromRow(row), action, rules);
    return {
      verification: { ...result, action, latency_ms: Date.now() - started },
      source: { record: row, rules },
    };
  } catch {
    return {
      verification: {
        decision: "BLOCK",
        action,
        evidence: [],
        reason: "Unable to verify the proposed action against authoritative transaction state.",
        risk: "high",
        latency_ms: Date.now() - started,
      },
    };
  }
}

/** The complete shared boundary: fresh read -> verifier -> durable audit -> executor. */
export async function verifyAndExecuteRecoveryAction<T>(
  input: Parameters<typeof verifyRecoveryAction>[0],
  executor: (verification: VerificationResult, source: VerifiedSources) => T | Promise<T>,
  auditContext: Pick<AuditInput, "transaction_ref" | "customer_id"> = {},
): Promise<{ verification: VerificationResult; execution: ExecutionGateResult<Awaited<T>> }> {
  const { verification, source } = await inspectRecoveryAction(input);
  const event = {
    ...auditContext,
    case_id: input.caseId,
    actor: "action_verifier",
    action: input.action,
    reason: verification.reason,
    result: JSON.stringify(verification),
  };
  await writeAudit(
    input.db,
    input.userId,
    [
      { ...event, event_type: "VERIFICATION_ATTEMPTED" },
      {
        ...event,
        event_type:
          verification.decision === "APPROVE"
            ? "ACTION_GROUNDING_APPROVED"
            : "ACTION_GROUNDING_BLOCKED",
      },
    ],
    { required: true },
  );
  const execution = runVerifiedExecutor(verification, () => {
    if (!source) throw new Error("Approved execution requires verified source data.");
    return executor(verification, source);
  });
  return {
    verification,
    execution: execution.executed ? { executed: true, result: await execution.result } : execution,
  };
}
