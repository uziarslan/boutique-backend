import { connectPlatform } from '../db/connections.js';

// Per-tenant DBs are opened on demand by the auth middleware via
// getTenantConnectionFor(slug). This boot step only opens the platform/
// registry DB so the tenants/userIndex/platformAdmin collections are usable.
const connect = async () => {
  await connectPlatform();
};

export default connect;
