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

  test('verify url contains', () => {
    const s = parseOne('Verify url contains /secure');
    expect(s.type).toBe('validation');
    expect(s.validation).toBe('url');
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
