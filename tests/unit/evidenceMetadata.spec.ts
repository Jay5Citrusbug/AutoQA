import { test, expect } from '@playwright/test';
import { EvidenceCollector, ReportExporter, TestReport, EvidenceMetadata } from '@/lib/report-bug-tracker';

/**
 * The evidence panel in the report renders each artifact's size and offers a
 * link to open it. Both come straight from this metadata, so a wrong size or a
 * path that was never written shows up as "0.00 MB" and a 404 — which is what
 * these cases guard against.
 */
test.describe('EvidenceCollector — what the evidence panel is told', () => {
  const collector = () => new EvidenceCollector('run_1', 'TC01');

  test('a local screenshot reports its real size, not an estimate', () => {
    const c = collector();
    c.addScreenshot(1, '/screenshots/run-1-step-1.png', 40_812);

    const [shot] = c.compileEvidenceMetadata();
    expect(shot.fileSizeBytes).toBe(40_812);
    expect(shot.storageType).toBe('local');
    expect(shot.publicUrl).toBe('/screenshots/run-1-step-1.png');
    expect(shot.storageId).toBeUndefined();
  });

  test('an uploaded screenshot points at Cloudinary and keeps its public id', () => {
    const c = collector();
    c.addScreenshot(1, '/screenshots/run-1-step-1.png', 40_812, {
      url: 'https://res.cloudinary.com/demo/image/upload/autoqa/step-1.png',
      publicId: 'autoqa/screenshots/run-1/step-1',
      sizeBytes: 41_000,
    });

    const [shot] = c.compileEvidenceMetadata();
    expect(shot.storageType).toBe('cloudinary');
    expect(shot.publicUrl).toContain('res.cloudinary.com');
    expect(shot.storageId).toBe('autoqa/screenshots/run-1/step-1');
    // Cloudinary's own count wins over what we measured locally.
    expect(shot.fileSizeBytes).toBe(41_000);
  });

  test('the video carries the size the runner measured on disk', () => {
    const c = collector();
    c.captureVideo('/videos/run-1-TC01.webm', 1_022_478);

    const [video] = c.compileEvidenceMetadata();
    expect(video.type).toBe('video');
    expect(video.fileSizeBytes).toBe(1_022_478);
    expect(video.publicUrl).toBe('/videos/run-1-TC01.webm');
  });

  test('a written log file replaces the estimate with its real path and size', () => {
    const c = collector();
    c.addConsoleLog({ level: 'error', message: 'boom', args: [], timestamp: '2026-01-01T00:00:00Z' });
    c.attachLogArtifact('console_log', {
      filePath: '/reports/logs/execution-run_1/console.log',
      sizeBytes: 57,
    });

    const [log] = c.compileEvidenceMetadata();
    expect(log.type).toBe('console_log');
    expect(log.fileSizeBytes).toBe(57);
    // Root-relative, so the link resolves from any page in the report.
    expect(log.publicUrl).toBe('/reports/logs/execution-run_1/console.log');
  });

  test('an un-exported log still falls back to an estimate rather than zero', () => {
    const c = collector();
    c.addConsoleLog({ level: 'info', message: 'hello', args: [], timestamp: '2026-01-01T00:00:00Z' });

    const [log] = c.compileEvidenceMetadata();
    expect(log.fileSizeBytes).toBeGreaterThan(0);
  });
});

test.describe('Playwright traces in the report', () => {
  const report: TestReport = {
    id: 'rep-1',
    executionId: 'run_1',
    testCaseId: 'TC01',
    status: 'failed',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    durationMs: 60_000,
  };

  const traceEvidence = (overrides: Partial<EvidenceMetadata>): EvidenceMetadata[] => [
    {
      id: 'ev-1',
      executionId: 'run_1',
      type: 'trace',
      filePath: '/traces/run-1-TC01.zip',
      fileSizeBytes: 2_400_000,
      storageType: 'local',
      ...overrides,
    } as EvidenceMetadata,
  ];

  test('the collector records a trace as its own evidence type', () => {
    const c = new EvidenceCollector('run_1', 'TC01');
    c.captureTrace('/traces/run-1-TC01.zip', 2_400_000);

    const [trace] = c.compileEvidenceMetadata();
    expect(trace.type).toBe('trace');
    expect(trace.fileSizeBytes).toBe(2_400_000);
  });

  test('an uploaded trace opens in the hosted Trace Viewer', () => {
    const url = 'https://res.cloudinary.com/ukjbhyt1/raw/upload/autoqa/traces/run-1/TC01.zip';
    const html = new ReportExporter().exportToHtml(
      report,
      [],
      [],
      [],
      undefined,
      traceEvidence({ storageType: 'cloudinary', publicUrl: url, storageId: 'autoqa/traces/run-1/TC01' }),
    );

    expect(html).toContain('trace.playwright.dev/?trace=');
    expect(html).toContain(encodeURIComponent(url));
    expect(html).toContain('View Trace');
  });

  test('a local-only trace links to the file itself, since the viewer could not fetch it', () => {
    const html = new ReportExporter().exportToHtml(report, [], [], [], undefined, traceEvidence({}));

    expect(html).not.toContain('trace.playwright.dev');
    expect(html).toContain('/traces/run-1-TC01.zip');
  });
});
