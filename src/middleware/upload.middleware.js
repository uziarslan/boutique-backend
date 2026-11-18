import multer from 'multer';

// ─── Menu item image upload ─────────────────────────────────────────────────
// Images are streamed straight to Cloudinary, so they live in memory (no disk
// write). Field name must be "image".

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const imageFileFilter = (_req, file, cb) => {
  if (IMAGE_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, and WebP images are allowed.'));
  }
};

export const uploadMenuImage = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('image');
