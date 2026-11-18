import crypto from 'crypto';

const secretKey = () => {
  const secret = process.env.SHOPIFY_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('SHOPIFY_ENCRYPTION_KEY must be configured with at least 32 characters.');
  }
  return crypto.scryptSync(secret, 'boutique-shopify-secret-v1', 32);
};

export const encryptShopifySecret = (plain) => {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `s1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
};

export const decryptShopifySecret = (value) => {
  if (!value || typeof value !== 'string' || !value.startsWith('s1:')) return '';
  try {
    const [, ivValue, tagValue, encryptedValue] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivValue, 'base64'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
};
