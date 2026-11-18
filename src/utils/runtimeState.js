let draining = false;

export const setDraining = (value = true) => {
  draining = Boolean(value);
};

export const isDraining = () => draining;

export const buildReadiness = (connectionHealth) => {
  const platformReady = connectionHealth?.platform?.readyState === 1;
  const ready = !draining && platformReady;
  return {
    status: ready ? 'ok' : 'unavailable',
    ready,
    draining,
    database: {
      platform: connectionHealth?.platform?.state || 'disconnected',
      openTenants: connectionHealth?.tenants?.open || 0,
      connectingTenants: connectionHealth?.tenants?.connecting || 0,
    },
    timestamp: new Date().toISOString(),
  };
};
