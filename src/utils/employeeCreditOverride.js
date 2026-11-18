export const canOverrideEmployeeCreditLimits = (actor, { ownerOnly = false } = {}) => {
  if (actor?.role === 'owner') return true;
  if (ownerOnly) return false;
  return typeof actor?.hasPermission === 'function'
    && actor.hasPermission('salaries.overrideCreditLimits');
};

