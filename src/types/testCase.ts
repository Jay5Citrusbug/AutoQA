export type ActionType = 'fill' | 'click' | 'select' | 'check' | 'uncheck' | 'navigate' | 'wait';

export type ValidationType =
  | 'url'          // URL contains / matches value
  | 'not_url'      // URL does NOT contain value
  | 'text'         // Page body contains text
  | 'not_text'     // Page body does NOT contain text
  | 'visible'      // Element / text is visible on page
  | 'not_visible'  // Element / text is hidden / not visible
  | 'enabled'      // Element is enabled (interactive)
  | 'disabled'     // Element is disabled (non-interactive)
  | 'success_msg'  // A success banner / toast is visible
  | 'error_msg';   // An error banner / toast is visible

export interface ParsedStep {
  stepIndex: number;
  rawText: string;
  // 'unparsed' means no known pattern matched — the runner reports it as a failure
  // with a clear message instead of blindly guessing an action.
  type: 'action' | 'validation' | 'unparsed';
  action?: ActionType;
  validation?: ValidationType;
  targetField: string; // E.g., 'email', 'loginButton', 'submit'
  value?: string;      // E.g., value to type, or text to validate
  waitMs?: number;     // For wait actions
  // Human-readable reason a step could not be understood (only set when type === 'unparsed').
  parseWarning?: string;
}

export interface TestCase {
  id: string;
  title: string;
  description?: string;
  steps: ParsedStep[];
  stepsText: string;
  websiteUrl?: string;
  moduleName?: string;
  createdAt: string;
  updatedAt: string;
}
