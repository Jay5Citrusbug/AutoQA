import { test, expect } from '@playwright/test';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { ParsedStep } from '@/types/testCase';

const parser = new TestCaseParser();
const parseOne = (line: string): ParsedStep => parser.parse([line])[0];

test.describe('TestCaseParser — navigation URL extraction', () => {
  test('extracts a URL embedded after a label', () => {
    const s = parseOne('open Login page - https://stage.optevo.com/login');
    expect(s.type).toBe('action');
    expect(s.action).toBe('navigate');
    expect(s.value).toBe('https://stage.optevo.com/login');
  });

  test('extracts a quoted URL', () => {
    const s = parseOne('Navigate to "https://the-internet.herokuapp.com/login"');
    expect(s.action).toBe('navigate');
    expect(s.value).toBe('https://the-internet.herokuapp.com/login');
  });

  test('keeps a bare domain path', () => {
    const s = parseOne('go to example.com/login');
    expect(s.action).toBe('navigate');
    expect(s.value).toBe('example.com/login');
  });
});

test.describe('TestCaseParser — fills', () => {
  test('enter X into Y', () => {
    const s = parseOne('Enter "tomsmith" into username field');
    expect(s.action).toBe('fill');
    expect(s.targetField).toBe('username');
    expect(s.value).toBe('tomsmith');
  });

  test('preserves {{variable}} references in the value', () => {
    const s = parseOne('Enter {{qa_valid_username}} into email');
    expect(s.action).toBe('fill');
    expect(s.targetField).toBe('email');
    expect(s.value).toContain('{{qa_valid_username}}');
  });

  test('valid credentials shorthand', () => {
    const s = parseOne('Enter valid credentials');
    expect(s.action).toBe('fill');
    expect(s.targetField).toBe('credentials');
    expect(s.value).toBe('valid');
  });
});

test.describe('TestCaseParser — clicks & assertions', () => {
  test('click strips button noun', () => {
    const s = parseOne('Click the Login button');
    expect(s.action).toBe('click');
    expect(s.targetField.toLowerCase()).toBe('login');
  });

  test('verify success message', () => {
    const s = parseOne('Verify success message "You logged into a secure area"');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('success_msg');
    expect(s.value).toContain('You logged into a secure area');
  });

  test('verify error message without explicit payload', () => {
    const s = parseOne('verify error message');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('error_msg');
    expect(s.value).toBeUndefined();
  });

  test('verify error message with explicit text', () => {
    const s = parseOne('verify error message "Invalid email or password"');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('error_msg');
    expect(s.value).toBe('Invalid email or password');
  });

  test('verify url contains', () => {
    const s = parseOne('Verify url contains /secure');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('url');
  });

  test('url should contain', () => {
    const s = parseOne('url should contain /dashboard');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('url');
    expect(s.value).toBe('/dashboard');
  });

  test('url should not contain', () => {
    const s = parseOne('url should not contain /login');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('not_url');
    expect(s.value).toBe('/login');
  });

  test('should be visible', () => {
    const s = parseOne('"Welcome back" should be visible');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('visible');
    expect(s.value).toBe('Welcome back');
  });

  test('should be hidden / not visible', () => {
    const s = parseOne('"Spinner" should be hidden');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('not_visible');
    expect(s.value).toBe('Spinner');
  });

  test('should be disabled', () => {
    const s = parseOne('"Submit button" should be disabled');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('disabled');
    expect(s.targetField).toBe('Submit button');
  });

  test('should see / should not see BDD style', () => {
    const s1 = parseOne('I should see "Dashboard"');
    expect(s1.type).toBe('validation');
    expect(s1.validation).toBe('text');
    expect(s1.value).toBe('Dashboard');

    const s2 = parseOne('should not see "Error message"');
    expect(s2.type).toBe('validation');
    expect(s2.validation).toBe('not_text');
    expect(s2.value).toBe('Error message');
  });
});

test.describe('TestCaseParser — unparsed steps (never blind-click)', () => {
  test('unknown imperative becomes unparsed, not a click', () => {
    const s = parseOne('Frobnicate the primary widget');
    expect(s.type).toBe('unparsed');
    expect(s.action).toBeUndefined();
    expect(s.parseWarning).toBeTruthy();
  });

  test('gibberish becomes unparsed', () => {
    const s = parseOne('asdf qwer zxcv');
    expect(s.type).toBe('unparsed');
  });
});
