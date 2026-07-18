/**
 * scriptVerifier.ts — Re-runs a generated Playwright spec headless to confirm it
 * actually replays. Only specs that pass here should be trusted for regression.
 *
 * Opt-in via RunConfig.verifyScript (default off) because each verification
 * spawns a real browser and roughly doubles a run's wall-clock time.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { ScriptVerificationResult } from '@/types/execution';
import { logger } from '@/utils/logger';

const GENERATED_CONFIG = 'playwright.generated.config.ts';
const VERIFY_TIMEOUT_MS = 150_000;

export interface IScriptVerifier {
  verify(specFileName: string): Promise<ScriptVerificationResult>;
}

export class ScriptVerifier implements IScriptVerifier {
  /**
   * @param specFileName Bare spec filename (e.g. "test_x_tc01_abcd.spec.ts") located in generated-tests/.
   */
  public async verify(specFileName: string): Promise<ScriptVerificationResult> {
    const start = Date.now();
    const cwd = process.cwd();
    const specPath = path.join(cwd, 'generated-tests', specFileName);

    if (!fs.existsSync(specPath)) {
      return { status: 'error', durationMs: 0, output: `Spec not found: ${specFileName}` };
    }

    return new Promise<ScriptVerificationResult>((resolve) => {
      const args = [
        'playwright',
        'test',
        specFileName,
        `--config=${GENERATED_CONFIG}`,
        '--project=chromium',
      ];

      const child = spawn('npx', args, {
        cwd,
        env: { ...process.env },
        shell: process.platform === 'win32', // npx resolution on Windows
      });

      let out = '';
      const capture = (buf: Buffer) => {
        out += buf.toString();
        if (out.length > 20_000) out = out.slice(-20_000); // keep tail only
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({
          status: 'error',
          durationMs: Date.now() - start,
          output: `Verification timed out after ${VERIFY_TIMEOUT_MS / 1000}s.\n${out.slice(-2000)}`,
        });
      }, VERIFY_TIMEOUT_MS);

      child.on('error', (err) => {
        clearTimeout(timer);
        logger.error('Script verification failed to spawn', err);
        resolve({ status: 'error', durationMs: Date.now() - start, output: err.message });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        resolve({
          status: code === 0 ? 'verified' : 'broken',
          durationMs,
          output: out.slice(-4000),
        });
      });
    });
  }
}
