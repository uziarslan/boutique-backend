import { isFeatureEnabledForOutlet } from './outletFeatures.service.js';

// Check the employee's actual outlet after identification, rather than only
// an outlet supplied by the caller or an aggregate tenant feature flag.
export const attendanceCaptureAccessError = ({ tenant, employee, outletConstraints = [], externalDevice = false, camera = false, livenessPassed = false }) => {
  const outlet = employee?.outlet;
  const outletId = String(outlet?._id || outlet || '');
  const outletCode = String(outlet?.code || '').trim().toUpperCase();
  if (!employee || employee.isActive === false) {
    return { status: 404, code: 'EMPLOYEE_UNAVAILABLE', message: 'Employee not found.' };
  }
  if (!outletId) {
    return { status: 403, code: 'OUTLET_REQUIRED', message: 'Assign this employee to an outlet before recording attendance.' };
  }
  if (outletConstraints.filter(Boolean).some((value) => (
    String(value) !== outletId && String(value).trim().toUpperCase() !== outletCode
  ))) {
    return { status: 403, code: 'OUTLET_MISMATCH', message: 'This employee is not assigned to this attendance outlet.' };
  }
  if (!isFeatureEnabledForOutlet(tenant, 'attendance', outletId)
    || (externalDevice && !isFeatureEnabledForOutlet(tenant, 'attendanceExternalDevice', outletId))) {
    return { status: 403, code: 'FEATURE_DISABLED', message: 'This attendance method is not enabled for this outlet. Contact your administrator.' };
  }
  if (camera && isFeatureEnabledForOutlet(tenant, 'attendanceLiveness', outletId) && !livenessPassed) {
    return { status: 400, code: 'LIVENESS_REQUIRED', message: 'Liveness check required. Please complete the blink and head-turn prompts, then try again.' };
  }
  return null;
};
