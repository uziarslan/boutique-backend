// Access tokens themselves remain valid for seven days. This is intentionally a
// tracked application policy rather than an environment-only value, so login,
// refresh, POS, and platform-admin token issuers cannot drift back to a short
// lifetime in another deployment.
export const ACCESS_TOKEN_EXPIRES_IN = '7d';
export const ACCESS_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
