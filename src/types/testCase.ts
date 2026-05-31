export type ActionType = 'fill' | 'click' | 'select' | 'check' | 'uncheck' | 'navigate' | 'wait';

export type ValidationType = 'url' | 'text' | 'visible' | 'enabled' | 'success_msg' | 'error_msg';

export interface ParsedStep {
  stepIndex: number;
  rawText: string;
  type: 'action' | 'validation';
  action?: ActionType;
  validation?: ValidationType;
  targetField: string; // E.g., 'email', 'loginButton', 'submit'
  value?: string;      // E.g., value to type, or text to validate
  waitMs?: number;     // For wait actions
}

export interface TestCase {
  id: string;
  title: string;
  description?: string;
  steps: ParsedStep[];
}
