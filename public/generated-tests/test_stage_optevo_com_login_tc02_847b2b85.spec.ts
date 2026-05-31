import { test, expect } from '@playwright/test';

// AutoQA Generated Playwright Spec
// Browser: chromium  |  Device: desktop
// Run ID: 847b2b85-bc74-4334-866c-4ae574d2ab7a  |  TC: TC02

test.describe('AutoQA Generated Test Run', () => {
  test('Verify execution flow on target site', async ({ page }) => {
    test.setTimeout(300000); // 5 min — handles slow redirects

    // Step 2: Step 1: Enter invalid credentials.
    await page.locator('[name="username"], #username, .username, input[type="text"] & [name="password"], #password, .password, input[type="text"]').fill('invalid');

    // Step 4: Expected Result: Error message "Log In Error Incorrect Email" is displayed when user enters invalid email and password" displayed in red.
    await expect(page.locator('body')).toContainText('Log In Error Incorrect Email', { timeout: 120000 });

  });
});
