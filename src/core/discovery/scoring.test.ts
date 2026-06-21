import { 
  levenshteinDistance, 
  calculateSimilarity, 
  fuzzyMatch, 
  scoreElement, 
  ElementAttributes, 
  ScoringContext 
} from './scoring';

function runTests() {
  console.log('=== STARTING SMART LOCATOR SCORER TESTS ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.log(`[FAIL] ${message}`);
      failed++;
    }
  }

  // --- Test 1: Levenshtein Distance & Fuzzy Match ---
  console.log('\n--- Test 1: Fuzzy Matching & Typo Tolerance ---');
  assert(levenshteinDistance('email', 'email') === 0, 'Distance between identical strings is 0');
  assert(levenshteinDistance('email', 'emial') === 2, 'Distance between email and emial is 2');
  assert(calculateSimilarity('email', 'emial') === 60, 'Similarity between email and emial is 60%');
  assert(fuzzyMatch('password', 'pasword', 80), 'Fuzzy match password vs pasword (1 deletion) is valid');
  assert(fuzzyMatch('email', 'e-mail', 80), 'Fuzzy match email vs e-mail (1 hyphen) is valid');
  assert(!fuzzyMatch('username', 'password', 50), 'Fuzzy match username vs password should fail');

  // --- Test 2: Multi-Language / Translation Intent Expansion ---
  console.log('\n--- Test 2: Multi-Language Intent Mapping ---');
  
  // Simulated email input in Spanish form
  const emailAttrs: ElementAttributes = {
    id: 'correo-electronico',
    name: 'correo',
    type: 'text',
    placeholder: 'ingrese su correo',
    ariaLabel: 'correo de login',
    ariaDescribedby: '',
    labelText: 'Dirección de correo',
    elementText: '',
    classNames: 'input-field',
    tagName: 'input',
    role: 'textbox',
    title: '',
    dataTestId: '',
    value: '',
    autocomplete: 'email',
    position: 0,
    totalFieldsInForm: 3,
    isVisible: true
  };

  const emailCtx: ScoringContext = {
    targetText: 'email field',
    rawTarget: 'email field'
  };

  const emailResult = scoreElement(emailAttrs, emailCtx);
  assert(emailResult.score >= 80, `Email Spanish element score is high: ${emailResult.score} (winning signal: ${emailResult.winningSignal})`);

  // --- Test 3: Cumulative Scoring Verification ---
  console.log('\n--- Test 3: Cumulative Scoring ---');

  // Exact matching element
  const primaryEmailAttrs: ElementAttributes = {
    id: 'user-email',
    name: 'email',
    type: 'email',
    placeholder: 'Enter Email Address',
    ariaLabel: 'Email Address',
    ariaDescribedby: '',
    labelText: 'Email Address',
    elementText: '',
    classNames: 'form-control',
    tagName: 'input',
    role: 'textbox',
    title: '',
    dataTestId: 'email-input',
    value: '',
    autocomplete: 'email',
    position: 0,
    totalFieldsInForm: 4,
    isVisible: true,
    helpText: 'We will never share your email.'
  };

  const perfectMatchResult = scoreElement(primaryEmailAttrs, { targetText: 'email', rawTarget: 'email' });
  assert(perfectMatchResult.score === 100, `Perfect email match should get maximum score (100). Got: ${perfectMatchResult.score}`);

  // Weak/Unrelated element
  const unrelatedAttrs: ElementAttributes = {
    id: 'submit-btn',
    name: 'submit',
    type: 'submit',
    placeholder: '',
    ariaLabel: '',
    ariaDescribedby: '',
    labelText: '',
    elementText: 'Submit Form',
    classNames: 'btn btn-primary',
    tagName: 'button',
    role: 'button',
    title: '',
    dataTestId: '',
    value: '',
    autocomplete: '',
    position: 3,
    totalFieldsInForm: 4,
    isVisible: true
  };

  const unrelatedResult = scoreElement(unrelatedAttrs, { targetText: 'email', rawTarget: 'email' });
  assert(unrelatedResult.score < 20, `Unrelated button should score very low for 'email' intent. Got: ${unrelatedResult.score}`);

  // --- Test 4: Sibling & Help/Error Text Matching ---
  console.log('\n--- Test 4: Advanced Attributes (Help / Error text) ---');
  
  const helpTextAttrs: ElementAttributes = {
    id: 'username-field',
    name: 'field',
    type: 'text',
    placeholder: '',
    ariaLabel: '',
    ariaDescribedby: '',
    labelText: '',
    elementText: '',
    classNames: 'input',
    tagName: 'input',
    role: 'textbox',
    title: '',
    dataTestId: '',
    value: '',
    autocomplete: '',
    position: 1,
    totalFieldsInForm: 4,
    isVisible: true,
    helpText: 'Enter your preferred account username here'
  };

  const helpTextResult = scoreElement(helpTextAttrs, { targetText: 'username', rawTarget: 'username' });
  assert(helpTextResult.score >= 50, `Matches keyword in helpText. Score: ${helpTextResult.score}`);

  console.log(`\n=== TEST SUITE COMPLETE: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
