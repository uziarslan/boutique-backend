import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import {
  listEmployees,
  getEmployee,
  createEmployee,
  previewEmployeeBulkImport,
  bulkImportEmployees,
  updateEmployee,
  enrollEmployeeFace,
  deactivateEmployee,
} from '../controllers/salary.controller.js';

const router = Router();

// Preserve /api/salary/employees for client compatibility, but make Employee
// Management independent from the Payroll feature.
router.get('/', protect, requireFeature('employees'), requirePermission('employees.view'), listEmployees);
router.get('/:id', protect, requireFeature('employees'), requirePermission('employees.view'), getEmployee);
router.post('/bulk-import/preview', protect, requireFeature('employees'), requirePermission('employees.manage'), previewEmployeeBulkImport);
router.post('/bulk-import', protect, requireFeature('employees'), requirePermission('employees.manage'), auditLog('Employee', 'BULK_IMPORT'), bulkImportEmployees);
router.post('/', protect, requireFeature('employees'), requirePermission('employees.manage'), createEmployee);
router.put('/:id', protect, requireFeature('employees'), requirePermission('employees.manage'), updateEmployee);
router.put('/:id/face-enroll', protect, requireFeature('employees'), requirePermission('employees.manage'), enrollEmployeeFace);
router.delete('/:id', protect, requireFeature('employees'), requirePermission('employees.manage'), deactivateEmployee);

export default router;
