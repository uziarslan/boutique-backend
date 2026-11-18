import crypto from 'crypto';

// Small symmetric encrypt/decrypt for secrets stored at rest (e.g. PRA/PRAL API
// tokens). AES-256-GCM with a key derived from a server secret. The key never
// leaves the server and is not stored with the data.
//
// Format: "v1:<iv b64>:<authTag b64>:<ciphertext b64>".

const keyCache = new Map();

const currentSecret = () => (
  process.env.PRA_ENC_KEY
  || process.env.FBR_ENC_KEY
  || process.env.JWT_SECRET
  || 'cenciss-dev-fallback-secret'
);

const getKey = (secret) => {
  if (keyCache.has(secret)) return keyCache.get(secret);
  const key = crypto.scryptSync(secret, 'cenciss-secretbox-v1', 32);
  keyCache.set(secret, key);
  return key;
};

// Encrypt a plaintext string. Empty/nullish input returns '' (nothing stored).
export const encryptSecret = (plain) => {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(currentSecret()), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
};

// Decrypt a blob produced by encryptSecret. Returns '' on any failure or for a
// value that isn't in our format (e.g. legacy plaintext) — callers treat ''
// as "no usable secret".
const decryptWithSecret = (blob, secret) => {
  if (!secret) return null;
  try {
    const [, ivB64, tagB64, dataB64] = blob.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getKey(secret),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
};

export const isSecretEncryptedWithCurrentKey = (blob) => {
  if (!blob || typeof blob !== 'string' || !blob.startsWith('v1:')) return false;
  return decryptWithSecret(blob, currentSecret()) !== null;
};

export const decryptSecret = (blob) => {
  if (!blob || typeof blob !== 'string' || !blob.startsWith('v1:')) return '';
  const current = decryptWithSecret(blob, currentSecret());
  if (current !== null) return current;

  // Used only during a controlled zero-downtime key rotation. Remove this
  // environment variable after every stored token has been re-encrypted.
  const previous = decryptWithSecret(
    blob,
    process.env.PRA_ENC_KEY_PREVIOUS || process.env.FBR_ENC_KEY_PREVIOUS || '',
  );
  return previous === null ? '' : previous;
};
