import { Router } from 'express';
import protect, { optionalProtect } from '../middleware/auth.middleware.js';
import attachTenantViaDeviceOrUser from '../middleware/attendanceDevice.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import authorize from '../middleware/role.middleware.js';
import {
  listAttendanceEmployees,
  getAttendanceEmployeeByPhone,
  createAttendance,
  identifyAttendanceByFace,
  matchEmployeeByFace,
  completeAttendanceByFaceMatch,
  listAttendanceRecords,
  markAttendanceRecordsApproved,
  listAttendanceByEmployee,
  upsertManualAttendanceRecord,
  bulkUpsertManualAttendance,
  getManualAttendanceSheet,
  getShiftCorrectionContext,
  postShiftCorrection,
} from '../controllers/attendance.controller.js';

const router = Router();

// Keep the legacy /api/pos/attendance URL, but authorize management requests
// against Attendance itself rather than the unrelated POS entitlement.
router.get('/records', protect, requireFeature('attendance'), requirePermission('attendance.view'), listAttendanceRecords);
router.get('/employee/:employeeId/records', protect, requireFeature('attendance'), requirePermission('attendance.view'), listAttendanceByEmployee);
router.get('/employee/:employeeId/shift-correction', protect, requireFeature('attendance'), authorize('owner'), getShiftCorrectionContext);
router.post('/employee/:employeeId/shift-correction', protect, requireFeature('attendance'), authorize('owner'), postShiftCorrection);
router.post('/records/mark-approved', protect, requireFeature('attendance'), requirePermission('attendance.manage'), markAttendanceRecordsApproved);
router.get('/manual/sheet', protect, requireFeature('attendance'), requirePermission('attendance.manage'), getManualAttendanceSheet);
router.put('/manual', protect, requireFeature('attendance'), requirePermission('attendance.manage'), auditLog('Attendance', 'MANUAL_UPSERT'), upsertManualAttendanceRecord);
router.post('/manual/bulk', protect, requireFeature('attendance'), requirePermission('attendance.manage'), auditLog('Attendance', 'MANUAL_BULK_UPSERT'), bulkUpsertManualAttendance);

// Resolve the tenant first so the Attendance feature switch is also enforced
// for paired devices, not only for authenticated management users.
const deviceOrJwt = [attachTenantViaDeviceOrUser(true), optionalProtect];

router.get('/employees', deviceOrJwt, requireFeature('attendance'), listAttendanceEmployees);
router.get('/employee-by-phone', deviceOrJwt, requireFeature('attendance'), getAttendanceEmployeeByPhone);
router.post('/', deviceOrJwt, requireFeature('attendance'), createAttendance);
router.post('/face-identify', deviceOrJwt, requireFeature('attendance'), identifyAttendanceByFace);
router.post('/face-match', deviceOrJwt, requireFeature('attendance'), matchEmployeeByFace);
router.post('/face-complete', deviceOrJwt, requireFeature('attendance'), completeAttendanceByFaceMatch);

export default router;
