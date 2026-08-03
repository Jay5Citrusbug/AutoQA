/**
 * stepLinter.ts — Tells an author what the runner will do with their steps,
 * before a browser is ever launched.
 *
 * Everything here is derived from the real parser, never a second
 * reimplementation of its rules. A linter that approximates the parser is worse
 * than none: it eventually disagrees with it, and then the tool contradicts
 * itself about whether a test case is valid.
 *
 * There are three verdicts a step can get, and the distinction matters:
 *
 *   ok       the runner knows exactly what to do
 *   warning  it will run, but the runner had to supply something the author
 *            did not — an auto-generated field value, say. Not an error, but
 *            never silent either: invented data has to be visible at authoring
 *            time, or a test quietly stops testing what its author intended.
 *   error    it cannot run at all. Nothing downstream can rescue this, so the
 *            run should not start.
 */

import { TestCaseParser } from './testCaseParser';
import { ParsedStep } from '@/types/testCase';

export type StepDiagnosticLevel = 'ok' | 'warning' | 'error';

export interface StepDiagnostic {
  /** Position within its test case, 1-based. */
  stepIndex: number;
  /** The step exactly as the author wrote it. */
  rawText: string;
  level: StepDiagnosticLevel;
  /** What the runner will do — "click «Save»", "fill «Email» with «bob@x.com»". */
  interpretation: string;
  /** Why this is not `ok`. Absent when it is. */
  message?: string;
  /** A concrete rewrite that resolves the problem. */
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
  /** True when nothing blocks execution. Warnings do not block. */
  runnable: boolean;
}

/** Renders what the runner will actually do with a parsed step, in plain words. */
function describe(step: ParsedStep): string {
  if (step.type === 'unparsed') return 'Not understood — this step will not run.';

  if (step.type === 'validation') {
    const target = step.targetField && step.targetField !== 'body' ? ` on «${step.targetField}»` : '';
    const value = step.value ? ` «${step.value}»` : '';
    return `Assert [${step.validation}]${target}${value}`;
  }

  switch (step.action) {
    case 'navigate':
      return `Navigate to «${step.value ?? 'the run URL'}»`;
    case 'click':
      return `Click «${step.targetField}»`;
    case 'fill':
      if (step.targetField === 'credentials') {
        return `Fill the login form with the ${step.value} credential set (from .env)`;
      }
      return step.autoValue
        ? `Fill «${step.targetField}» with a value generated at run time`
        : `Fill «${step.targetField}» with «${step.value ?? ''}»`;
    case 'select':
      return step.autoValue
        ? `Select the first available option in «${step.targetField}»`
        : `Select «${step.value}» in «${step.targetField}»`;
    case 'check':
      return `Tick «${step.targetField}»`;
    case 'uncheck':
      return `Untick «${step.targetField}»`;
    case 'wait':
      return `Wait ${step.waitMs ?? 1000}ms`;
    case 'waitUntil':
      return `Wait until «${step.targetField}» is ${step.waitMode ?? 'visible'}`;
    default:
      return 'Run this step';
  }
}

function diagnoseStep(step: ParsedStep): StepDiagnostic {
  if (step.type === 'unparsed') {
    return {
      stepIndex: step.stepIndex,
      rawText: step.rawText,
      level: 'error',
      interpretation: describe(step),
      message: step.parseWarning,
      suggestion: step.parseSuggestion,
    };
  }

  if (step.autoValue) {
    const isSelect = step.action === 'select';
    return {
      stepIndex: step.stepIndex,
      rawText: step.rawText,
      level: 'warning',
      interpretation: describe(step),
      message: isSelect
        ? `No option was named, so the first selectable option in «${step.targetField}» will be chosen and reported.`
        : `No value was given, so one will be generated for «${step.targetField}» and reported. ` +
          `It differs between runs, so do not assert on it literally.`,
      suggestion: isSelect
        ? `select "<option>" from ${step.targetField}`
        : `${step.rawText.trim()} as "<your value>"`,
    };
  }

  return {
    stepIndex: step.stepIndex,
    rawText: step.rawText,
    level: 'ok',
    interpretation: describe(step),
  };
}

/**
 * Lints a whole multi-test-case step blob — the same text the run endpoint is
 * given, parsed by the same parser, so the verdict cannot drift from reality.
 */
export function lintStepsText(stepsText: string): LintReport {
  const parser = new TestCaseParser();
  const suites = parser.parseTestSuites(stepsText);

  const report: LintReport = {
    suites: [],
    totalSteps: 0,
    errorCount: 0,
    warningCount: 0,
    runnable: true,
  };

  for (const suite of suites) {
    const steps = suite.steps.map(diagnoseStep);
    const errorCount = steps.filter((s) => s.level === 'error').length;
    const warningCount = steps.filter((s) => s.level === 'warning').length;

    report.suites.push({
      tcId: suite.id,
      title: suite.title,
      steps,
      errorCount,
      warningCount,
    });
    report.totalSteps += steps.length;
    report.errorCount += errorCount;
    report.warningCount += warningCount;
  }

  report.runnable = report.errorCount === 0;
  return report;
}

/** A compact, human-readable rendering of everything blocking a run. */
export function formatBlockingErrors(report: LintReport): string[] {
  const lines: string[] = [];
  for (const suite of report.suites) {
    for (const step of suite.steps) {
      if (step.level !== 'error') continue;
      lines.push(
        `${suite.tcId} step ${step.stepIndex}: "${step.rawText}" — ${step.message ?? 'could not be understood'}` +
          (step.suggestion ? ` Try: ${step.suggestion}` : ''),
      );
    }
  }
  return lines;
}
