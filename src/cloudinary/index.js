import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_KEY,
    api_secret: process.env.CLOUDINARY_SECRET,
});

// Root folder under which every restaurant's assets are grouped:
//   restaurant-management/<restaurant-slug>/...
const ROOT_FOLDER = 'restaurant-management';

// Build the per-restaurant folder. Falls back to "_shared" if no slug is given
// so an upload can never land at the bucket root by accident.
const folderForSlug = (slug) => {
    const clean = String(slug || '').trim().toLowerCase();
    return clean ? `${ROOT_FOLDER}/${clean}` : `${ROOT_FOLDER}/_shared`;
};

/**
 * Upload an image buffer to Cloudinary under the restaurant's slug folder.
 *
 * @param {Buffer} buffer  Raw image bytes (memory-storage multer file.buffer).
 * @param {string} slug    Restaurant slug (req.tenantSlug) — becomes the folder.
 * @returns {Promise<{ url: string, publicId: string }>}
 */
export const uploadImage = (buffer, slug) =>
    new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: folderForSlug(slug),
                resource_type: 'image',
                // Store a deliberately low-quality, compact image to save space
                // and bandwidth: cap to 800px and force aggressive compression.
                transformation: [
                    { width: 800, height: 800, crop: 'limit' },
                    { quality: 'auto:low', fetch_format: 'auto' },
                ],
            },
            (error, result) => {
                if (error) return reject(error);
                resolve({ url: result.secure_url, publicId: result.public_id });
            }
        );
        stream.end(buffer);
    });

/**
 * Delete an image from Cloudinary by its public_id. Safe to call with a falsy
 * id (resolves to null) so callers don't need to guard.
 *
 * @param {string} publicId  Cloudinary public_id stored on the record.
 */
export const deleteImage = (publicId) => {
    if (!publicId) return Promise.resolve(null);
    return cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
};

export {
    cloudinary,
};
