/**
 * Verifies the Cloudinary credentials in .env actually work.
 *
 *   npm run cloudinary:check
 *
 * Checks three things in order, because each one fails for a different reason:
 *   1. all three variables are present   -> otherwise the app silently stays local
 *   2. the account authenticates (ping)  -> wrong cloud name / key / secret
 *   3. an upload and delete round-trips  -> key is valid but lacks permission
 */
import { v2 as cloudinary } from 'cloudinary';

const REQUIRED = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('✗ Missing in .env: ' + missing.join(', '));
  console.error('  Artifacts will stay on local disk under public/ until these are set.');
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const folder = process.env.CLOUDINARY_FOLDER || 'autoqa';

try {
  await cloudinary.api.ping();
  console.log(`✓ Authenticated against cloud "${process.env.CLOUDINARY_CLOUD_NAME}"`);
} catch (err) {
  console.error('✗ Cloudinary rejected the credentials: ' + (err?.error?.message || err?.message));
  console.error('  Check the cloud name, API key and API secret in .env.');
  process.exit(1);
}

// A 1x1 transparent PNG — the smallest thing that proves upload rights.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let publicId;
try {
  const result = await cloudinary.uploader.upload(PIXEL, {
    folder: `${folder}/_healthcheck`,
    public_id: `check-${Date.now()}`,
    resource_type: 'image',
  });
  publicId = result.public_id;
  console.log(`✓ Upload works — wrote ${result.public_id}`);
} catch (err) {
  console.error('✗ Upload failed: ' + (err?.error?.message || err?.message));
  process.exit(1);
}

try {
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  console.log('✓ Delete works — test asset cleaned up');
} catch {
  console.warn(`! Could not delete the test asset; remove ${publicId} by hand if you care.`);
}

// Playwright traces are .zip files, and Cloudinary blocks ZIP delivery by
// default on every account. The upload still succeeds, so this only surfaces as
// a broken Trace Viewer link unless it is checked explicitly.
let zipOk = false;
let zipId;
try {
  const zip = await cloudinary.uploader.upload(
    'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
    {
      folder: `${folder}/_healthcheck`,
      public_id: `check-${Date.now()}.zip`,
      resource_type: 'raw',
    },
  );
  zipId = zip.public_id;

  const res = await fetch(zip.secure_url);
  if (res.ok) {
    zipOk = true;
    console.log('✓ ZIP delivery is enabled — Trace Viewer links will work');
  } else {
    const reason = res.headers.get('x-cld-error') || `HTTP ${res.status}`;
    console.warn(`! ZIP delivery is BLOCKED by your account (${reason}).`);
    console.warn('  Traces upload fine, but the Trace Viewer cannot fetch them.');
    console.warn('  Fix: Cloudinary Console > Settings > Security > Restricted media types');
    console.warn('       > allow delivery of PDF and ZIP files.');
    console.warn('  Meanwhile, open a trace locally: npx playwright show-trace <file>');
  }
} catch (err) {
  console.warn('! Could not verify ZIP delivery: ' + (err?.error?.message || err?.message));
}

if (zipId) {
  await cloudinary.uploader.destroy(zipId, { resource_type: 'raw' }).catch(() => {});
}

console.log(`\nReady. Run evidence will publish under the "${folder}/" folder.`);
if (!zipOk) {
  console.log('Traces are still saved and uploaded — only the one-click viewer link is affected.');
}
