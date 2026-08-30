import fs from 'fs';
import path from 'path';
import { v2 as cloudinary } from 'cloudinary';
import { logger } from '@/utils/logger';

/**
 * Cloudinary is the artifact store for run evidence — screenshots, session
 * videos, exported reports and log files.
 *
 * It is optional on purpose. A developer running the app without an account
 * still gets a working run: every upload helper returns `null` when the three
 * credentials are absent, and callers fall back to the local `public/` path
 * they already wrote. Evidence is therefore never lost because a key is
 * missing — it just stays on the machine that produced it.
 */

export type CloudinaryResourceType = 'image' | 'video' | 'raw';

export interface UploadResult {
  /** CDN url to serve the artifact from. */
  secureUrl: string;
  /** Cloudinary public id, needed to delete or transform the asset later. */
  publicId: string;
  /** Size Cloudinary recorded for the stored asset, in bytes. */
  bytes: number;
  resourceType: CloudinaryResourceType;
}

/** Root folder every AutoQA artifact is nested under, so one account can host several apps. */
const ROOT_FOLDER = process.env.CLOUDINARY_FOLDER || 'autoqa';

let configured: boolean | undefined;

/**
 * True when all three credentials are present. Cached after the first call —
 * a run uploads many files and there is no reason to re-read env each time.
 */
export function isCloudinaryConfigured(): boolean {
  if (configured !== undefined) return configured;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  configured = Boolean(cloudName && apiKey && apiSecret);

  if (configured) {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });
  } else {
    logger.info(
      'Cloudinary is not configured (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET). ' +
        'Run evidence will be kept on local disk only.',
    );
  }

  return configured;
}

/** Test seam: forget the cached credential check so a new env can take effect. */
export function resetCloudinaryConfigCache(): void {
  configured = undefined;
}

/**
 * Uploads a file that already exists on disk.
 *
 * Returns `null` — never throws — when Cloudinary is unconfigured, the file is
 * missing, or the upload fails. Losing the CDN copy of a screenshot must not
 * fail the test run that produced it.
 */
export async function uploadFile(
  filePath: string,
  options: {
    /** Sub-folder under the root, e.g. `screenshots/run-123`. */
    folder: string;
    /** `auto` lets Cloudinary infer image vs video from the file itself. */
    resourceType?: CloudinaryResourceType | 'auto';
    /** Filename within the folder; defaults to the local basename without its extension. */
    publicId?: string;
  },
): Promise<UploadResult | null> {
  if (!isCloudinaryConfigured()) return null;

  if (!fs.existsSync(filePath)) {
    logger.error(`Cloudinary upload skipped, file not found: ${filePath}`);
    return null;
  }

  const resourceType = options.resourceType ?? 'auto';

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: `${ROOT_FOLDER}/${options.folder}`,
      public_id: options.publicId ?? path.parse(filePath).name,
      resource_type: resourceType,
      overwrite: true,
    });

    return {
      secureUrl: result.secure_url,
      publicId: result.public_id,
      bytes: result.bytes,
      resourceType: result.resource_type as CloudinaryResourceType,
    };
  } catch (error) {
    logger.error(`Cloudinary upload failed for ${filePath}`, error);
    return null;
  }
}

/**
 * Uploads text produced in memory (a console log, a HAR archive, an exported
 * report) without staging it on disk first. Stored as a `raw` asset so it is
 * served back verbatim rather than being treated as an image.
 */
export async function uploadText(
  content: string,
  options: { folder: string; publicId: string; contentType?: string },
): Promise<UploadResult | null> {
  if (!isCloudinaryConfigured()) return null;

  const contentType = options.contentType ?? 'text/plain';
  const dataUri = `data:${contentType};base64,${Buffer.from(content, 'utf-8').toString('base64')}`;

  try {
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: `${ROOT_FOLDER}/${options.folder}`,
      public_id: options.publicId,
      resource_type: 'raw',
      overwrite: true,
    });

    return {
      secureUrl: result.secure_url,
      publicId: result.public_id,
      bytes: result.bytes,
      resourceType: 'raw',
    };
  } catch (error) {
    logger.error(`Cloudinary text upload failed for ${options.publicId}`, error);
    return null;
  }
}

/** Removes an asset. Used by retention cleanup; failures are logged, not thrown. */
export async function deleteAsset(
  publicId: string,
  resourceType: CloudinaryResourceType = 'image',
): Promise<boolean> {
  if (!isCloudinaryConfigured()) return false;

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return true;
  } catch (error) {
    logger.error(`Cloudinary delete failed for ${publicId}`, error);
    return false;
  }
}
