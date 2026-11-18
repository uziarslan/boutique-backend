const usesTls = (url) => {
  try {
    return new URL(url).protocol === 'rediss:';
  } catch {
    return false;
  }
};

// Heroku Key-Value Store encrypts every connection with TLS but uses a
// self-signed certificate. These options follow Heroku's required Node.js
// client configuration and are only applied to explicit rediss:// URLs.
export const ioredisTlsOptions = (url) => (
  usesTls(url)
    ? { tls: { rejectUnauthorized: false } }
    : {}
);

export const nodeRedisSocketOptions = (url) => (
  usesTls(url)
    ? { rejectUnauthorized: false }
    : {}
);

