/**
 * failureClassifier.ts — Separates "the application is wrong" from "the
 * automation could not carry out the step".
 *
 * A failed run means one of three quite different things, and conflating them is
 * what makes an automation suite untrustworthy:
 *
 *   product-defect  The step ran against the app exactly as written and the app
 *                   behaved differently from the expectation. This is the only
 *                   kind worth raising against the product.
 *
 *   automation-gap  The step never really reached the app: wording the parser
 *                   could not turn into an action, a locator that resolved to
 *                   nothing, a missing test-data variable. The app may be
 *                   perfectly healthy — the test could not ask it the question.
 *
 *   environment     Neither the app nor the test: browser launch failure, DNS or
 *                   connection error, a run the user cancelled.
 *
 * Only product-defect failures are filed as bugs. Filing the other two trains
 * everyone to ignore the bug queue, which costs far more than the missed report.
 */
import { FailureClassification, StepExecutionResult } from '@/types/execution';

export type FailureKind = FailureClassification['kind'];
export type { FailureClassification };

/** Evidence gathered elsewhere in the run that can override a weak verdict. */
export interface FailureEvidence {
  /** Any request that came back 5xx. */
  hasServerError?: boolean;
  /** An uncaught exception in the page. */
  hasUncaughtError?: boolean;
}

// The engine raises these with stable prefixes, so matching them is reliable.
const ELEMENT_NOT_FOUND = /^element not found for /i;
const UNSUPPORTED_ACTION = /^unsupported action:/i;
const MISSING_TEST_DATA = /^unresolved test-data variable/i;

// Failures that are neither the app's fault nor the test's.
const ENVIRONMENT_SIGNATURES = [
  /browser launch\/context error/i,
  /execution cancelled by user/i,
  /net::ERR_/i,
  /ERR_CONNECTION/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_INTERNET_DISCONNECTED/i,
  /browserType\.launch/i,
  /Target (page|closed)/i,
];

/**
 * Reads a suite's step results and returns the verdict for its first failure,
 * or null when nothing failed.
 */
export function classifyFailure(
  stepResults: StepExecutionResult[],
  evidence: FailureEvidence = {},
): FailureClassification | null {
  const failure = stepResults.find((r) => r.status === 'failed');
  if (!failure) return null;

  const error = failure.error || '';
  const stepIndex = failure.stepIndex;

  // Wording the parser could not turn into an action never reached the browser,
  // so it says nothing at all about the application — not even when the app is
  // simultaneously throwing errors.
  if (failure.step.type === 'unparsed') {
    return {
      kind: 'automation-gap',
      label: 'Automation gap — step wording not understood',
      reason: `Step ${stepIndex} could not be turned into an action, so it never ran against the application.`,
      nextStep:
        'Rewrite the step to start with an action verb (click, enter, select, navigate) or an assertion (verify/expect), then re-run.',
      fileAsBug: false,
      stepIndex,
    };
  }

  // Hard evidence the application itself broke outranks the shape of the step:
  // a 5xx or an uncaught exception is the app failing, however the step failed.
  if (evidence.hasServerError || evidence.hasUncaughtError) {
    const what = evidence.hasServerError ? 'a 5xx server response' : 'an uncaught JavaScript exception';
    return {
      kind: 'product-defect',
      label: 'Product defect — application error during the step',
      reason: `Step ${stepIndex} failed while the application produced ${what}.`,
      nextStep: 'Raise against the application; the network and console evidence is attached to this report.',
      fileAsBug: true,
      stepIndex,
    };
  }

  if (ENVIRONMENT_SIGNATURES.some((re) => re.test(error))) {
    return {
      kind: 'environment',
      label: 'Environment issue — the run could not proceed',
      reason: `Step ${stepIndex} failed on infrastructure rather than on the application: ${firstLine(error)}`,
      nextStep: 'Check browser installation, network access and target availability, then re-run.',
      fileAsBug: false,
      stepIndex,
    };
  }

  if (ELEMENT_NOT_FOUND.test(error)) {
    return {
      kind: 'automation-gap',
      label: 'Automation gap — element could not be located',
      reason: `Step ${stepIndex} could not resolve a locator for "${failure.step.targetField}", so the interaction never happened.`,
      nextStep:
        'Confirm the element is present at this point in the flow. If it is, describe it more specifically (its visible text, or its position such as "top right") or add an id / data-testid.',
      fileAsBug: false,
      stepIndex,
    };
  }

  if (MISSING_TEST_DATA.test(error)) {
    return {
      kind: 'automation-gap',
      label: 'Automation gap — test data missing',
      reason: `Step ${stepIndex} referenced a test-data variable that is not configured: ${firstLine(error)}`,
      nextStep: 'Set the missing variable in the environment configuration and re-run.',
      fileAsBug: false,
      stepIndex,
    };
  }

  if (UNSUPPORTED_ACTION.test(error)) {
    return {
      kind: 'automation-gap',
      label: 'Automation gap — action not supported',
      reason: `Step ${stepIndex} asked for an action the runner does not implement: ${firstLine(error)}`,
      nextStep: 'Express the step using a supported action, or add support for it in the runner.',
      fileAsBug: false,
      stepIndex,
    };
  }

  // An assertion is the test putting a question to the application. It ran, the
  // app answered, and the answer was wrong — the definition of a product defect.
  if (failure.step.type === 'validation') {
    return {
      kind: 'product-defect',
      label: 'Product defect — application behaved differently from the expectation',
      reason: `Step ${stepIndex} executed against the application and the result did not match: ${firstLine(error)}`,
      nextStep:
        'Confirm which side is wrong. If the application is correct here, the expectation in the test case needs updating; otherwise raise it as a defect.',
      fileAsBug: true,
      stepIndex,
    };
  }

  // The locator resolved but the interaction still did not complete — usually an
  // overlay, an animation or a control that never became ready. That is a timing
  // problem in the automation far more often than a broken feature, so it is not
  // filed as a bug without the corroborating app evidence handled above.
  return {
    kind: 'automation-gap',
    label: 'Automation gap — interaction did not complete',
    reason: `Step ${stepIndex} located its element but the ${failure.step.action ?? 'interaction'} did not complete: ${firstLine(error)}`,
    nextStep:
      'Check the failure screenshot for an overlay or dialog covering the control, and add a wait step for it if so. If the control is genuinely dead, raise it as a defect.',
    fileAsBug: false,
    stepIndex,
  };
}

function firstLine(text: string): string {
  const line = (text || '').split('\n')[0].trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
