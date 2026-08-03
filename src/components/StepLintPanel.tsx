'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';

/** Mirrors the server-side StepDiagnostic in @/core/parser/stepLinter. */
export interface StepDiagnostic {
  stepIndex: number;
  rawText: string;
  level: 'ok' | 'warning' | 'error';
  interpretation: string;
  message?: string;
  suggestion?: string;
}

export interface SuiteDiagnostic {
  tcId: string;
  title: string;
  steps: StepDiagnostic[];
  errorCount: number;
  warningCount: number;
}

export interface LintReport {
  suites: SuiteDiagnostic[];
  totalSteps: number;
  errorCount: number;
  warningCount: number;
  runnable: boolean;
}

/**
 * Debounced live linting of a step blob.
 *
 * Debounced rather than per-keystroke because a half-typed step is not a
 * mistake — flagging "Enter workp" in red while somebody is still typing it
 * trains them to ignore the panel, which costs more than the delay saves.
 */
export function useStepLint(stepsText: string, delayMs = 600) {
  const [report, setReport] = React.useState<LintReport | null>(null);
  const [checking, setChecking] = React.useState(false);
  const trimmed = stepsText.trim();

  React.useEffect(() => {
    if (!trimmed) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      setChecking(true);
      fetch('/api/steps/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepsText: trimmed }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: LintReport | null) => {
          if (!cancelled && data) setReport(data);
        })
        .catch(() => {
          // A linting outage must never block authoring — the run endpoint
          // performs the same check server-side regardless.
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, delayMs]);

  // Derived rather than cleared in an effect, so an emptied editor shows nothing
  // immediately instead of briefly keeping the previous file's verdict on screen.
  return { report: trimmed ? report : null, checking: trimmed ? checking : false };
}

const LEVEL_STYLES = {
  error: {
    icon: XCircle,
    row: 'border-rose-500/30 bg-rose-500/5',
    text: 'text-rose-400',
  },
  warning: {
    icon: AlertTriangle,
    row: 'border-amber-500/30 bg-amber-500/5',
    text: 'text-amber-400',
  },
  ok: {
    icon: CheckCircle2,
    row: 'border-zinc-800 bg-zinc-900/30',
    text: 'text-emerald-400',
  },
} as const;

/**
 * Shows what the runner will do with each step, before it is run.
 *
 * Steps that are fine are collapsed by default: a wall of green tells the
 * author nothing they need to act on, and burying two real problems inside
 * twenty confirmations is how they get missed.
 */
export function StepLintPanel({
  report,
  checking,
  className = '',
}: {
  report: LintReport | null;
  checking?: boolean;
  className?: string;
}) {
  const [showAll, setShowAll] = React.useState(false);

  if (!report || report.totalSteps === 0) {
    return checking ? (
      <div className={`flex items-center gap-2 text-xs text-zinc-500 ${className}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking steps...
      </div>
    ) : null;
  }

  const problems = report.suites.flatMap((s) =>
    s.steps.filter((st) => st.level !== 'ok').map((st) => ({ suite: s, step: st })),
  );
  const visible = showAll
    ? report.suites.flatMap((s) => s.steps.map((st) => ({ suite: s, step: st })))
    : problems;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 text-xs sm:text-sm font-bold">
          {report.errorCount > 0 ? (
            <span className="flex items-center gap-1.5 text-rose-400">
              <XCircle className="h-4 w-4" />
              {report.errorCount} step{report.errorCount === 1 ? '' : 's'} cannot run
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              All {report.totalSteps} steps are runnable
            </span>
          )}
          {report.warningCount > 0 && (
            <span className="flex items-center gap-1.5 text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              {report.warningCount} need{report.warningCount === 1 ? 's' : ''} generated data
            </span>
          )}
          {checking && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
        </div>

        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs font-bold text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          {showAll ? 'Show only problems' : `Show all ${report.totalSteps} steps`}
        </button>
      </div>

      {report.errorCount > 0 && (
        <p className="text-xs text-rose-300/80 font-semibold">
          The run will not start until these are fixed — nothing would execute anyway.
        </p>
      )}

      {visible.length > 0 && (
        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
          {visible.map(({ suite, step }) => {
            const style = LEVEL_STYLES[step.level];
            const Icon = style.icon;
            return (
              <div
                key={`${suite.tcId}-${step.stepIndex}-${step.rawText}`}
                className={`border rounded-lg px-3 py-2 flex gap-2.5 ${style.row}`}
              >
                <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${style.text}`} />
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[10px] font-mono font-bold text-zinc-500 uppercase">
                      {suite.tcId} · step {step.stepIndex}
                    </span>
                    <span className="font-mono text-xs text-zinc-300 break-words">{step.rawText}</span>
                  </div>
                  <span className="text-xs text-zinc-400">{step.interpretation}</span>
                  {step.message && <span className={`text-xs ${style.text}`}>{step.message}</span>}
                  {step.suggestion && (
                    <span className="text-xs text-zinc-400 flex items-start gap-1.5">
                      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-sky-400" />
                      <span>
                        Try: <code className="font-mono text-sky-300">{step.suggestion}</code>
                      </span>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
