import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Bot, Gauge, ShieldCheck, TrendingUp } from "lucide-react";

import { Logo } from "@/components/brand/Logo";
import { Pill } from "@/components/console/primitives";
import { Button } from "@/components/ui/button";

const TITLE = "RecoverAI — AI Revenue Recovery Agent for Failed Payments";
const DESCRIPTION =
  "RecoverAI detects revenue at risk from failed and abandoned payments, diagnoses the cause, and executes bounded recovery actions with a full audit trail.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: Landing,
});

const STEPS = [
  { title: "Detect", body: "Every failed, abandoned and dunning event becomes a scored revenue-at-risk case." },
  { title: "Diagnose", body: "Failure signals, customer history and payment method feed a structured AI diagnosis." },
  { title: "Decide", body: "The agent selects one bounded recovery action within your retry, window and probability limits." },
  { title: "Verify", body: "Fresh DB + PayPal evidence must independently approve — AI recommendations never authorize execution." },
  { title: "Act", body: "Only a deterministic APPROVE permits a PayPal Sandbox checkout or recovery execution." },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/auth">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/auth" search={{ mode: "signup" }}>
              Open the console
            </Link>
          </Button>
        </div>
      </header>

      <main>
        <section className="grid-glow">
          <div className="mx-auto max-w-4xl px-6 py-24 text-center">
            <Pill tone="info">PayPal AI Hackathon 2026</Pill>
            <h1 className="mt-6 text-4xl leading-tight font-semibold tracking-tight sm:text-6xl">
              AI-powered payment recovery with real PayPal Sandbox
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
              RecoverAI detects failed payments, generates AI recovery recommendations, verifies every action
              against authoritative evidence, and executes approved recoveries through the PayPal Orders API.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg">
                <Link to="/auth" search={{ mode: "signup" }}>
                  Launch demo console <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/auth">Sign in</Link>
              </Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Free account · Seeded with synthetic payment data · Real PayPal Sandbox checkout included
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-20">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { icon: TrendingUp, title: "Quantified exposure", body: "Revenue at risk, recoverable revenue and recovery rate, tracked daily from real data." },
              { icon: Bot, title: "AI + deterministic safety", body: "The AI proposes. The deterministic verifier decides. Nothing executes outside that boundary." },
              { icon: ShieldCheck, title: "Hard PayPal guardrails", body: "Amount, currency, order status and ownership verified before every capture. No duplicate charges." },
            ].map((f) => (
              <div key={f.title} className="panel p-5">
                <f.icon className="size-5 text-primary" aria-hidden />
                <h2 className="mt-3 text-sm font-semibold">{f.title}</h2>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>

          <div className="panel mt-6 p-6">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-primary" aria-hidden />
              <h2 className="text-sm font-semibold">The recovery workflow</h2>
            </div>
            <ol className="mt-5 grid gap-4 md:grid-cols-5">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="num text-xs text-primary">0{i + 1}</span>
                  <p className="mt-1 text-sm font-medium">{s.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <p className="text-center text-xs text-muted-foreground">
          RecoverAI · PayPal AI Hackathon 2026 · Real PayPal Sandbox · Synthetic transaction data
        </p>
      </footer>
    </div>
  );
}
