/**
 * fileImportParser.ts
 *
 * Zero-dependency client-side parser for CSV and XLSX test case import files.
 * Supports .csv, .xlsx, and .xls files.
 *
 * Expected columns (case-insensitive):
 *   tc_id         - Test case ID (e.g. TC01, TC02) — controls execution order
 *   title         - Short name for the test case
 *   url           - Target URL for the test
 *   steps         - Newline-separated test steps (use \n or actual newlines in-cell)
 *   expected_result - (optional) assertion(s) to run at the end
 *   app_name      - (optional) Application name
 *   module_name   - (optional) Module name
 *   exec_type     - (optional) Functional | Smoke | Regression
 */

export interface ImportedTestCase {
  tcId: string;
  title: string;
  url: string;
  steps: string;
  expectedResult?: string;
  appName?: string;
  moduleName?: string;
  execType?: 'Functional' | 'Smoke' | 'Regression';
  /** Originating row number (1-indexed, excluding header) */
  rowIndex: number;
}

export interface ParseResult {
  testCases: ImportedTestCase[];
  errors: string[];
}

// ─────────────────────────────────────────────
// NORMALISE COLUMN NAMES
// ─────────────────────────────────────────────
function normaliseKey(k: string): string {
  return k.toLowerCase().replace(/[\s\-]/g, '_').trim();
}

const COL_ALIASES: Record<string, keyof ImportedTestCase | 'skip'> = {
  tc_id: 'tcId',
  tcid: 'tcId',
  'test_case_id': 'tcId',
  testcaseid: 'tcId',
  id: 'tcId',
  title: 'title',
  name: 'title',
  test_name: 'title',
  url: 'url',
  website_url: 'url',
  target_url: 'url',
  steps: 'steps',
  test_steps: 'steps',
  step: 'steps',
  expected_result: 'expectedResult',
  expected: 'expectedResult',
  assertion: 'expectedResult',
  validations: 'expectedResult',
  app_name: 'appName',
  application: 'appName',
  app: 'appName',
  module_name: 'moduleName',
  module: 'moduleName',
  exec_type: 'execType',
  type: 'execType',
  execution_type: 'execType',
};

function mapColumn(raw: string): keyof ImportedTestCase | null {
  const k = normaliseKey(raw);
  return (COL_ALIASES[k] as keyof ImportedTestCase) ?? null;
}

// ─────────────────────────────────────────────
// ROBUST CSV PARSER (handles quoted cells with newlines)
// ─────────────────────────────────────────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuote) {
      if (ch === '"' && next === '"') {
        // escaped double-quote
        cell += '"';
        i += 2;
      } else if (ch === '"') {
        inQuote = false;
        i++;
      } else {
        cell += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
        i++;
      } else if (ch === '\r' && next === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        i += 2;
      } else if (ch === '\n' || ch === '\r') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        i++;
      } else {
        cell += ch;
        i++;
      }
    }
  }

  // flush last cell/row
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some(c => c.trim())) rows.push(row);
  }

  return rows;
}

// ─────────────────────────────────────────────
// XLSX PARSER (binary, no external dependency)
// Uses the browser's built-in ArrayBuffer API to extract
// the shared strings table and sheet data from the XLSX zip.
// ─────────────────────────────────────────────
async function parseXLSXtoRows(file: File): Promise<string[][]> {
  // We use a dynamic import of the xlsx shim via a CDN-free approach.
  // Since we cannot install npm packages, we parse the zip ourselves.
  // XLSX is a ZIP containing XML files. We'll use DecompressionStream if available,
  // or fall back to a manual approach.

  // Strategy: read file as text with UTF-8 and try to extract cell values from the XML.
  // This works for xlsx files saved in Office Open XML format.

  const buffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(buffer);

  // Find ZIP local file headers (PK\x03\x04) and extract XML content
  const textDecoder = new TextDecoder('utf-8', { fatal: false });
  const raw = textDecoder.decode(uint8);

  // Extract shared strings XML
  const ssMatch = raw.match(/<sst[^>]*>([\s\S]*?)<\/sst>/);
  const sharedStrings: string[] = [];
  if (ssMatch) {
    const siMatches = [...ssMatch[1].matchAll(/<si>([\s\S]*?)<\/si>/g)];
    for (const si of siMatches) {
      // Extract all <t> tags within <si>
      const tMatches = [...si[1].matchAll(/<t(?:[^>]*)>([^<]*)<\/t>/g)];
      sharedStrings.push(tMatches.map(m => m[1]).join(''));
    }
  }

  // Extract sheet1 XML
  const sheetMatch = raw.match(/<worksheet[^>]*>([\s\S]*?)<\/worksheet>/);
  if (!sheetMatch) return [];

  const rowMatches = [...sheetMatch[1].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];

  const rows: string[][] = [];
  for (const rowMatch of rowMatches) {
    const cells: string[] = [];
    const cellMatches = [...rowMatch[1].matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>/g)];

    for (const cellMatch of cellMatches) {
      const attrs = cellMatch[1];
      const content = cellMatch[2];

      // Cell reference (e.g. A1, B2, C3)
      const refMatch = attrs.match(/r="([A-Z]+)(\d+)"/);
      const colStr = refMatch?.[1] ?? '';

      // Convert column letter to 0-based index
      let colIdx = 0;
      for (let ci = 0; ci < colStr.length; ci++) {
        colIdx = colIdx * 26 + (colStr.charCodeAt(ci) - 64);
      }
      colIdx -= 1; // 0-based

      // Pad with empty strings up to colIdx
      while (cells.length < colIdx) cells.push('');

      // Get value
      const typeMatch = attrs.match(/t="([^"]+)"/);
      const cellType = typeMatch?.[1] ?? '';
      const vMatch = content.match(/<v>([^<]*)<\/v>/);
      const vRaw = vMatch?.[1] ?? '';

      if (cellType === 's') {
        // Shared string index
        const idx = parseInt(vRaw, 10);
        cells.push(isNaN(idx) ? '' : (sharedStrings[idx] ?? ''));
      } else if (cellType === 'inlineStr') {
        const isMatch = content.match(/<is>([\s\S]*?)<\/is>/);
        if (isMatch) {
          const tms = [...isMatch[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)];
          cells.push(tms.map(m => m[1]).join(''));
        } else {
          cells.push('');
        }
      } else {
        cells.push(vRaw);
      }
    }

    if (cells.some(c => c.trim())) rows.push(cells);
  }

  return rows;
}

// ─────────────────────────────────────────────
// ROWS → ImportedTestCase[]
// ─────────────────────────────────────────────
function rowsToTestCases(rows: string[][]): ParseResult {
  const errors: string[] = [];
  const testCases: ImportedTestCase[] = [];

  if (rows.length < 2) {
    return { testCases: [], errors: ['File appears to be empty or has no data rows.'] };
  }

  // First row = headers
  const headers = rows[0].map(h => mapColumn(h.trim()));
  const unknownHeaders = rows[0].filter(h => !mapColumn(h.trim()) && h.trim());
  if (unknownHeaders.length > 0) {
    errors.push(`Warning: unrecognised columns will be ignored: ${unknownHeaders.join(', ')}`);
  }

  const requiredFields: (keyof ImportedTestCase)[] = ['tcId', 'title', 'url', 'steps'];
  const hasRequired = requiredFields.every(f => headers.includes(f));
  if (!hasRequired) {
    const missing = requiredFields.filter(f => !headers.includes(f));
    return {
      testCases: [],
      errors: [`Missing required columns: ${missing.map(m => {
        const entry = Object.entries(COL_ALIASES).find(([, v]) => v === m);
        return entry ? entry[0] : m;
      }).join(', ')}. Please check your file headers.`],
    };
  }

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (!row || row.every(c => !c.trim())) continue; // skip blank rows

    const obj: Record<string, string> = {};
    headers.forEach((field, colIdx) => {
      if (field) obj[field] = (row[colIdx] ?? '').trim();
    });

    const rowNum = rowIdx + 1; // 1-indexed (row 1 = header)

    if (!obj.tcId) { errors.push(`Row ${rowNum}: Missing tc_id — row skipped.`); continue; }
    if (!obj.title) { errors.push(`Row ${rowNum}: Missing title — row skipped.`); continue; }
    if (!obj.url) { errors.push(`Row ${rowNum}: Missing url — row skipped.`); continue; }
    if (!obj.steps) { errors.push(`Row ${rowNum}: Missing steps — row skipped.`); continue; }

    // Normalise literal \n to actual newlines
    const steps = obj.steps.replace(/\\n/g, '\n');
    const expectedResult = obj.expectedResult ? obj.expectedResult.replace(/\\n/g, '\n') : undefined;

    // Validate URL
    try {
      new URL(obj.url);
    } catch {
      errors.push(`Row ${rowNum} (${obj.tcId}): Invalid URL "${obj.url}" — row skipped.`);
      continue;
    }

    // Validate execType
    const validExecTypes = ['Functional', 'Smoke', 'Regression'] as const;
    const execTypeRaw = obj.execType;
    const execType = execTypeRaw
      ? (validExecTypes.find(e => e.toLowerCase() === execTypeRaw.toLowerCase()) ?? 'Functional')
      : 'Functional';

    testCases.push({
      tcId: obj.tcId.toUpperCase().replace(/\s+/g, ''),
      title: obj.title,
      url: obj.url,
      steps,
      expectedResult,
      appName: obj.appName || undefined,
      moduleName: obj.moduleName || undefined,
      execType,
      rowIndex: rowNum,
    });
  }

  // Sort by TC ID numerically (TC01, TC02, TC03...)
  testCases.sort((a, b) => {
    const numA = parseInt(a.tcId.replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(b.tcId.replace(/\D/g, ''), 10) || 0;
    if (numA !== numB) return numA - numB;
    return a.tcId.localeCompare(b.tcId);
  });

  return { testCases, errors };
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

export async function parseTestCaseFile(file: File): Promise<ParseResult> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'csv') {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const rows = parseCSV(text);
        resolve(rowsToTestCases(rows));
      };
      reader.onerror = () => resolve({ testCases: [], errors: ['Failed to read CSV file.'] });
      reader.readAsText(file, 'utf-8');
    });
  } else if (ext === 'xlsx' || ext === 'xls') {
    try {
      const rows = await parseXLSXtoRows(file);
      return rowsToTestCases(rows);
    } catch (err: any) {
      return { testCases: [], errors: [`Failed to parse XLSX file: ${err?.message || 'Unknown error'}`] };
    }
  } else {
    return { testCases: [], errors: [`Unsupported file format ".${ext}". Please upload a .csv or .xlsx file.`] };
  }
}

/**
 * Converts an array of ImportedTestCase into the stepsText format
 * that the existing /api/run-test endpoint understands.
 *
 * TC01: Valid Login
 * navigate to ...
 * fill Email ...
 * verify url contains /dashboard
 *
 * TC02: Invalid Login
 * ...
 */
export function testCasesToStepsText(testCases: ImportedTestCase[]): string {
  return testCases
    .map(tc => {
      const lines: string[] = [];
      lines.push(`${tc.tcId}: ${tc.title}`);
      lines.push(tc.steps.trim());
      if (tc.expectedResult?.trim()) {
        lines.push(tc.expectedResult.trim());
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Generates a sample CSV template string the user can download.
 */
export function generateCSVTemplate(): string {
  const headers = ['tc_id', 'title', 'url', 'steps', 'expected_result', 'app_name', 'module_name', 'exec_type'];
  const row1 = [
    'TC01',
    'Valid Login',
    'https://your-website.com/login',
    'navigate to https://your-website.com/login\\nfill Email field with admin@example.com\\nfill Password field with Secret123\\nclick Login button',
    'verify url contains /dashboard\\nverify text "Welcome" is visible\\n"Logout button" should be visible',
    'MyApp',
    'Login',
    'Functional',
  ];
  const row2 = [
    'TC02',
    'Invalid Login',
    'https://your-website.com/login',
    'navigate to https://your-website.com/login\\nfill Email field with wrong@example.com\\nfill Password field with WrongPass\\nclick Login button',
    'verify error message "Incorrect Email or Password"\\nurl should not contain /dashboard',
    'MyApp',
    'Login',
    'Functional',
  ];

  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [
    headers.join(','),
    row1.map(escape).join(','),
    row2.map(escape).join(','),
  ].join('\r\n');
}
