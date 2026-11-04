/**
 * PayPal Integration Dashboard — /console/paypal
 *
 * Shows PayPal Sandbox connectivity status, order/capture statistics,
 * recent PayPal activity, and provides a payment recovery checkout flow.
 *
 * All data comes from real server functions backed by the PayPal Sandbox API
 * and the Supabase database. Nothing is hardcoded.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Panel,
  Pill,
  formatDateTime,
} from "@/components/console/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatCurrencyPrecise } from "@/lib/recovery-engine";
import {
  capturePayPalRecoveryOrder,
  checkPayPalStatus,
  createPayPalRecoveryOrder,
  getPayPalStats,
  analyzePayPalTransaction,
} from "@/lib/paypal.functions";

const TITLE = "PayPal Integration — RecoverAI";
const DESCRIPTION =
  "PayPal Sandbox payment recovery: create checkout orders, capture approved payments, and monitor recovery outcomes.";

export const Route = createFileRoute("/_authenticated/console/paypal")({
  validateSearch: z.object({
    order_id: z.string().optional(), // our own param (legacy)
    token: z.string().optional(),    // PayPal appends ?token=ORDER_ID on return
    transaction_id: z.string().optional(),
    cancelled: z.string().optional(),
    PayerID: z.string().optional(),  // PayPal also appends PayerID
  }),
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PayPalPage,
});

// ─── Status pill helper ───────────────────────────────────────────────────────

function statusTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status.toUpperCase()) {
    case "COMPLETED":
    case "RECOVERED":
      return "success";
    case "APPROVED":
    case "PAYER_ACTION_REQUIRED":
      return "info";
    case "CREATED":
    case "SAVED":
    case "PENDING":
      return "warning";
    case "DECLINED":
    case "FAILED":
    case "VOIDED":
      return "danger";
    default:
      return "neutral";
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function PayPalPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: "/_authenticated/console/paypal" });

  const [transactionIdInput, setTransactionIdInput] = useState("");
  const [analysisResult, setAnalysisResult] = useState<Awaited<ReturnType<typeof analyzePayPalTransaction>> | null>(null);

  // Handle return from PayPal checkout
  // PayPal appends ?token=ORDER_ID&PayerID=XXX to the return URL
  const returnOrderId = search.token ?? search.order_id; // prefer PayPal's token param
  const returnTxId = search.transaction_id;
  const wasCancelled = search.cancelled === "true";

  // ── Queries ────────────────────────────────────────────────────────────────

  const statusQuery = useQuery({
    queryKey: ["paypal-status"],
    queryFn: () => checkPayPalStatus(),
    staleTime: 30_000,
    retry: false,
  });

  const statsQuery = useQuery({
    queryKey: ["paypal-stats"],
    queryFn: () => getPayPalStats(),
    staleTime: 15_000,
  });

  // ── Auto-capture on return from PayPal ────────────────────────────────────

  const captureMutation = useMutation({
    mutationFn: (paypalOrderId: string) => capturePayPalRecoveryOrder({ data: { paypalOrderId } }),
    onSuccess: async (result) => {
      if (result.alreadyCaptured) {
        toast.info("This payment was already captured.");
      } else if (result.status === "COMPLETED") {
        toast.success(
          `Payment captured: ${formatCurrencyPrecise(result.amount, result.currency)} recovered.`,
        );
      } else {
        toast.warning(`Capture status: ${result.status}. Check the activity table below.`);
      }
      await qc.invalidateQueries({ queryKey: ["paypal-stats"] });
      await qc.invalidateQueries({ queryKey: ["overview"] });
      await qc.invalidateQueries({ queryKey: ["transactions"] });
      // Remove query params after processing.
      void navigate({
        to: "/console/paypal",
        search: {},
        replace: true,
      });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Capture failed.");
    },
  });

  useEffect(() => {
    if (wasCancelled) {
      toast.warning("PayPal checkout was cancelled. No payment was taken.");
      void navigate({ to: "/console/paypal", search: {}, replace: true });
      return;
    }
    if (returnOrderId && !captureMutation.isPending && !captureMutation.isSuccess) {
      captureMutation.mutate(returnOrderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnOrderId, wasCancelled]);

  // ── Analyse PayPal order with AI engine ──────────────────────────────────

  const analysisMutation = useMutation({
    mutationFn: (paypalOrderId: string) =>
      analyzePayPalTransaction({ data: { paypalOrderId } }),
    onSuccess: (result) => {
      setAnalysisResult(result);
      toast.success(`AI analysis: ${result.decision.recommended_action} @ ${result.decision.recovery_probability}%`);
      void qc.invalidateQueries({ queryKey: ["paypal-stats"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "AI analysis failed.");
    },
  });

  // ── Create order mutation ─────────────────────────────────────────────────

  const createOrderMutation = useMutation({
    mutationFn: (transactionRef: string) =>
      createPayPalRecoveryOrder({
        data: {
          transactionRef,
          baseUrl: window.location.origin,
        },
      }),
    onSuccess: (result) => {
      toast.success("PayPal checkout created — redirecting to PayPal…");
      // Redirect to PayPal approval page.
      window.location.href = result.approveUrl;
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not create PayPal order.");
    },
  });

  const stats = statsQuery.data;
  const connected = statusQuery.data?.connected ?? false;
  const sandbox = statusQuery.data?.sandbox ?? true;

  // ── Capture feedback panel (shown while capturing) ────────────────────────

  const showCaptureProgress = captureMutation.isPending;
  const captureResult = captureMutation.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="PayPal Sandbox integration"
        description="Real PayPal Sandbox checkout and capture — no simulated responses."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ["paypal-stats"] });
              void qc.invalidateQueries({ queryKey: ["paypal-status"] });
            }}
          >
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </Button>
        }
      />

      {/* ── Connectivity status ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <div className="flex items-start gap-3">
            {statusQuery.isLoading ? (
              <Loader2 className="mt-0.5 size-5 animate-spin text-muted-foreground" />
            ) : connected ? (
              <CheckCircle2 className="mt-0.5 size-5 text-success" aria-hidden />
            ) : (
              <XCircle className="mt-0.5 size-5 text-destructive" aria-hidden />
            )}
            <div>
              <p className="text-sm font-medium">API connection</p>
              <p className="text-xs text-muted-foreground">
                {statusQuery.isLoading
                  ? "Checking…"
                  : connected
                    ? sandbox
                      ? "Sandbox connected"
                      : "Live connected"
                    : (statusQuery.data?.error ?? "Not connected")}
              </p>
            </div>
          </div>
        </Panel>

        <Panel>
          <div className="flex items-start gap-3">
            <Zap className="mt-0.5 size-5 text-chart-1" aria-hidden />
            <div>
              <p className="text-sm font-medium">Total orders</p>
              <p className="num text-2xl font-semibold">{stats?.totalOrders ?? "—"}</p>
            </div>
          </div>
        </Panel>

        <Panel>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 text-success" aria-hidden />
            <div>
              <p className="text-sm font-medium">Completed captures</p>
              <p className="num text-2xl font-semibold">{stats?.completedCaptures ?? "—"}</p>
            </div>
          </div>
        </Panel>

        <Panel>
          <div className="flex items-start gap-3">
            <CreditCard className="mt-0.5 size-5 text-chart-2" aria-hidden />
            <div>
              <p className="text-sm font-medium">Recovered via PayPal</p>
              <p className="num text-2xl font-semibold">
                {stats ? formatCurrency(stats.recoveredAmount) : "—"}
              </p>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── Config warning ── */}
      {!statusQuery.isLoading && !connected && (
        <Panel>
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">
                PayPal credentials not configured
              </p>
              <p className="text-xs text-muted-foreground">
                Add <code className="rounded bg-muted px-1">PAYPAL_CLIENT_ID</code> and{" "}
                <code className="rounded bg-muted px-1">PAYPAL_CLIENT_SECRET</code> to{" "}
                <code className="rounded bg-muted px-1">.env.local</code> to enable live PayPal
                Sandbox checkout. Get your credentials at{" "}
                <a
                  href="https://developer.paypal.com/dashboard/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  developer.paypal.com
                </a>
                .
              </p>
            </div>
          </div>
        </Panel>
      )}

      {/* ── Capture in progress ── */}
      {showCaptureProgress && (
        <Panel title="Capturing payment…">
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Verifying payment status with PayPal and recording the capture…
          </div>
        </Panel>
      )}

      {/* ── Capture result ── */}
      {captureResult && (
        <Panel
          title={
            captureResult.status === "COMPLETED"
              ? "Payment captured"
              : `Capture: ${captureResult.status}`
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">PayPal order</p>
              <p className="num mt-1 truncate text-sm font-medium">{captureResult.paypalOrderId}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Capture ID</p>
              <p className="num mt-1 truncate text-sm font-medium">{captureResult.captureId}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Amount</p>
              <p className="num mt-1 text-sm font-medium">
                {formatCurrencyPrecise(captureResult.amount, captureResult.currency)}
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            {captureResult.status === "COMPLETED" ? (
              <CheckCircle2 className="size-4 text-success" aria-hidden />
            ) : (
              <AlertCircle className="size-4 text-warning" aria-hidden />
            )}
            <span className="text-sm">
              {captureResult.alreadyCaptured
                ? "This payment was already captured — no duplicate charge."
                : captureResult.status === "COMPLETED"
                  ? "Payment successfully captured via PayPal Sandbox."
                  : `Capture status: ${captureResult.status}. Check PayPal dashboard for details.`}
            </span>
          </div>
        </Panel>
      )}

      {/* ── Create checkout ── */}
      <Panel
        title="Start a PayPal recovery checkout"
        description="Enter the transaction reference from the Transactions page to create a real PayPal Sandbox checkout."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="tx-id-input">
              Transaction reference{" "}
              <a href="/console/transactions" className="text-xs text-primary underline underline-offset-2">
                (copy from Transactions page)
              </a>
            </Label>
            <Input
              id="tx-id-input"
              className="num"
              placeholder="TXN-20260823-10001"
              value={transactionIdInput}
              onChange={(e) => setTransactionIdInput(e.target.value.trim())}
              disabled={createOrderMutation.isPending || !connected}
            />
            <p className="text-xs text-muted-foreground">
              Go to <strong>Transactions</strong> → find a <strong>Failed</strong> row → copy the
              reference in the first column (e.g. <code>TXN-20260823-10001</code>).
            </p>
          </div>
          <Button
            onClick={() => {
              if (!transactionIdInput) return;
              createOrderMutation.mutate(transactionIdInput);
            }}
            disabled={createOrderMutation.isPending || !transactionIdInput || !connected}
          >
            {createOrderMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ExternalLink className="size-4" aria-hidden />
            )}
            Create PayPal checkout
          </Button>
        </div>
        {createOrderMutation.isError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {createOrderMutation.error instanceof Error
              ? createOrderMutation.error.message
              : "Failed to create PayPal order."}
          </p>
        )}
      </Panel>

      {/* ── Security note ── */}
      <Panel title="Security architecture" description="How RecoverAI protects payment operations">
        <ul className="space-y-2.5 text-sm">
          {[
            {
              icon: ShieldCheck,
              text: "AI cannot directly execute payment operations — all actions pass through the deterministic verifier boundary.",
            },
            {
              icon: ShieldCheck,
              text: "PayPal order status is fetched from the PayPal API before every capture — frontend status is never trusted.",
            },
            {
              icon: ShieldCheck,
              text: "Amount and currency are always taken from the authoritative database record, not from client input.",
            },
            {
              icon: ShieldCheck,
              text: "Duplicate capture attempts are blocked by a unique constraint on paypal_capture_id.",
            },
            {
              icon: ShieldCheck,
              text: "Webhook events are signature-verified and stored idempotently — duplicate event IDs are ignored.",
            },
            {
              icon: ShieldCheck,
              text: "Customers must approve every payment through the official PayPal checkout. No unauthorized charges.",
            },
          ].map((item) => (
            <li key={item.text} className="flex items-start gap-2">
              <item.icon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span className="text-muted-foreground">{item.text}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── AI Analysis result ── */}
      {analysisResult && (
        <Panel title="AI recovery analysis" description="Based on authoritative PayPal transaction evidence">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">PayPal status</p>
              <p className="mt-1 font-semibold">{analysisResult.paypalStatus}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Recommended action</p>
              <p className="mt-1 font-semibold">{analysisResult.decision.recommended_action}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Recovery probability</p>
              <p className="num mt-1 font-semibold">{analysisResult.decision.recovery_probability}%</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Source</p>
              <p className="mt-1 font-semibold">{analysisResult.decision.source === "ai" ? "AI agent" : "Rule-based"}</p>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-border p-4 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Diagnosis</p>
            <p className="text-sm">{analysisResult.decision.diagnosis}</p>
            <p className="text-xs font-medium text-muted-foreground mt-2">Reason</p>
            <p className="text-sm">{analysisResult.decision.reason}</p>
          </div>
          <div className="mt-3 rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">PayPal evidence used</p>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div><span className="text-muted-foreground">Order ID: </span><span className="num font-medium">{analysisResult.paypalEvidence.orderId.slice(0,12)}…</span></div>
              <div><span className="text-muted-foreground">Status: </span><span className="font-medium">{analysisResult.paypalEvidence.status}</span></div>
              <div><span className="text-muted-foreground">Amount: </span><span className="num font-medium">{formatCurrencyPrecise(analysisResult.paypalEvidence.amount, analysisResult.paypalEvidence.currency)}</span></div>
              <div><span className="text-muted-foreground">Payer approved: </span><span className="font-medium">{analysisResult.paypalEvidence.payerApproved ? "Yes" : "No"}</span></div>
            </div>
          </div>
        </Panel>
      )}

      {/* ── Recent PayPal activity ── */}
      <Panel
        title="Recent PayPal orders"
        description="Last 20 orders created via RecoverAI recovery checkout"
      >
        {statsQuery.isError && (
          <ErrorState
            message={statsQuery.error instanceof Error ? statsQuery.error.message : undefined}
            onRetry={() => void statsQuery.refetch()}
            retrying={statsQuery.isFetching}
          />
        )}
        {statsQuery.isLoading && <LoadingBlock rows={5} label="Loading PayPal activity" />}
        {stats?.recentOrders.length === 0 && (
          <EmptyState
            title="No PayPal orders yet"
            description="Create a recovery checkout above to start recovering payments via PayPal Sandbox."
          />
        )}
        {stats && stats.recentOrders.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PayPal order ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">AI Analysis</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.recentOrders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="num text-xs">{order.paypal_order_id}</TableCell>
                    <TableCell>
                      <Pill tone={statusTone(order.status)}>{order.status}</Pill>
                    </TableCell>
                    <TableCell className="num text-xs">
                      {formatCurrencyPrecise(order.amount, order.currency)}
                    </TableCell>
                    <TableCell className="num text-xs text-muted-foreground">
                      {order.transaction_id.slice(0, 8)}…
                    </TableCell>
                    <TableCell className="num text-xs text-muted-foreground">
                      {formatDateTime(order.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={analysisMutation.isPending}
                        onClick={() => analysisMutation.mutate(order.paypal_order_id)}
                      >
                        {analysisMutation.isPending && analysisMutation.variables === order.paypal_order_id ? (
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                        ) : null}
                        Analyse
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {/* ── Pending captures ── */}
      {stats && stats.pendingOrders > 0 && (
        <Panel title={`${stats.pendingOrders} order(s) awaiting customer approval`}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4 shrink-0" aria-hidden />
            These orders have been created but the customer has not yet approved them in PayPal.
            They will be captured automatically when the customer returns via the checkout link.
          </div>
        </Panel>
      )}
    </div>
  );
}
