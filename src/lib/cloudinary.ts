import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a buffer to Cloudinary and return the secure URL.
 */
export const uploadReceipt = (buffer: Buffer, filename: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'buddystore/receipts',
        public_id: filename,
        resource_type: 'auto', // handles images + PDFs
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Upload failed'));
        resolve(result.secure_url);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
};

/**
 * Upload a given buffer to Cloudinary and return the secure URL for banners
 */
export const uploadBanner = (buffer: Buffer, filename: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'buddystore/banners',
        public_id: filename,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Upload failed'));
        resolve(result.secure_url);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
};

/**
 * Upload a PDF buffer to Cloudinary and return the secure URL.
 * Uses resource_type: 'raw' which is required for non-image files like PDFs.
 */
export const uploadPdf = (buffer: Buffer, filename: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'buddystore/pdfs',
        public_id: filename,
        resource_type: 'raw',
        type: 'upload',        // explicit: public delivery type
        access_mode: 'public', // never block delivery
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Upload failed'));
        resolve(result.secure_url);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
};

/**
 * Upload a video thumbnail buffer to Cloudinary and return the secure URL.
 */
export const uploadThumbnail = (buffer: Buffer, filename: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'buddystore/thumbnails',
        public_id: filename,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto', width: 480, crop: 'limit' }],
      },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Upload failed'));
        resolve(result.secure_url);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
};

/**
 * Delete multiple Cloudinary assets by their secure URLs.
 * Extracts the public_id from each URL and deletes in batches of 100.
 */
export const deleteCloudinaryImages = async (urls: (string | null | undefined)[]): Promise<void> => {
  // Filter out nulls and extract public_ids
  const publicIds = urls
    .filter((url): url is string => !!url)
    .map((url) => {
      // Cloudinary URL format:
      //   https://res.cloudinary.com/<cloud>/image/upload/vXXXX/<folder>/<public_id>.<ext>
      // We need everything after "/upload/vXXXX/" (or "/upload/") up to (but not including) the extension.
      const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/i);
      return match ? match[1] : null;
    })
    .filter((id): id is string => !!id);

  if (publicIds.length === 0) return;

  // Cloudinary API allows max 100 ids per request
  const BATCH_SIZE = 100;
  for (let i = 0; i < publicIds.length; i += BATCH_SIZE) {
    const batch = publicIds.slice(i, i + BATCH_SIZE);
    try {
      await cloudinary.api.delete_resources(batch);
      console.log(`[Cloudinary] Deleted ${batch.length} asset(s)`);
    } catch (err) {
      console.error(`[Cloudinary] Failed to delete batch starting at ${i}:`, err);
    }
  }
};

export default cloudinary;
