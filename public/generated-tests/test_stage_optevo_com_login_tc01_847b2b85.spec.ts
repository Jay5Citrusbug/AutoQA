import { test, expect } from '@playwright/test';

// AutoQA Generated Playwright Spec
// Browser: chromium  |  Device: desktop
// Run ID: 847b2b85-bc74-4334-866c-4ae574d2ab7a  |  TC: TC01

test.describe('AutoQA Generated Test Run', () => {
  test('Verify execution flow on target site', async ({ page }) => {
    test.setTimeout(300000); // 5 min — handles slow redirects

    // Step 2: Step 1: Navigate to the login page.
    await page.goto('login page.', { waitUntil: 'networkidle', timeout: 120000 });

    // Step 4: Step 2: Enter "jay.r@optevo.com" into the email field.
    await page.locator('input[name="userName"]').fill('jay.r@optevo.com');

    // Step 6: Step 3: Enter "Jayqa@1234" into the password field.
    await page.locator('input[name="password"]').fill('Jayqa@1234');

    // Step 8: Step 4: Click the "Log In" button.
    await page.locator('form#wf-form-Starter-Account > button').click();
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});

    // Step 10: Expected Result: The dashboard should be navigate https://stage.optevo.com/desktop/home
    await expect(page).toHaveURL(new RegExp("https://stage\\.optevo\\.com/desktop/home"), { timeout: 120000 });

    // Step 12: It should display an Optevo text logo on left top side and Ask Evo AI button text on navbar
    await expect(page.locator('body')).toContainText('Optevo', { timeout: 120000 });

  });
});
