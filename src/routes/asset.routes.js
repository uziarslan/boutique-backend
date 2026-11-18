import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import {
  getAssetMeta,
  getAssetAccountOptions,
  listAssetCategories,
  createAssetCategory,
  updateAssetCategory,
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  transferAsset,
  deactivateAsset,
  getAssetReconciliation,
} from '../controllers/asset.controller.js';
import {
  listAssetAudits,
  createAssetAudit,
  getAssetAudit,
  startAssetAudit,
  countAssetAuditLine,
  addUnregisteredAuditLine,
  submitAssetAudit,
  reviewAssetAudit,
  requestAssetAuditRecount,
  approveAssetAudit,
  rejectAssetAudit,
} from '../controllers/assetAudit.controller.js';
import {
  listDepreciationRuns,
  createDepreciationRun,
  getDepreciationRun,
  postDepreciationRun,
} from '../controllers/assetDepreciation.controller.js';

const router = Router();
router.use(protect);

router.get('/meta', requirePermission('assets.view'), getAssetMeta);
router.get('/account-options', requirePermission('assets.manage'), getAssetAccountOptions);

router.get('/categories', requirePermission('assets.view'), listAssetCategories);
router.post(
  '/categories',
  requirePermission('assets.manage'),
  auditLog('AssetCategory', 'CREATE'),
  createAssetCategory,
);
router.put(
  '/categories/:id',
  requirePermission('assets.manage'),
  auditLog('AssetCategory', 'UPDATE'),
  updateAssetCategory,
);

router.get('/audits', requirePermission('assets.view'), listAssetAudits);
router.post(
  '/audits',
  requirePermission('assetAudits.create'),
  auditLog('AssetAudit', 'CREATE'),
  createAssetAudit,
);
router.get('/audits/:id', requirePermission('assets.view'), getAssetAudit);
router.post(
  '/audits/:id/start',
  requirePermission('assetAudits.create'),
  auditLog('AssetAudit', 'START'),
  startAssetAudit,
);
router.patch(
  '/audits/:id/lines/:lineId/count',
  requirePermission('assetAudits.count'),
  auditLog('AssetAudit', 'COUNT'),
  countAssetAuditLine,
);
router.post(
  '/audits/:id/unregistered-lines',
  requirePermission('assetAudits.count'),
  auditLog('AssetAudit', 'COUNT_UNREGISTERED'),
  addUnregisteredAuditLine,
);
router.post(
  '/audits/:id/submit',
  requirePermission('assetAudits.count'),
  auditLog('AssetAudit', 'SUBMIT'),
  submitAssetAudit,
);
router.post(
  '/audits/:id/review',
  requirePermission('assetAudits.review'),
  auditLog('AssetAudit', 'REVIEW'),
  reviewAssetAudit,
);
router.post(
  '/audits/:id/recount',
  requirePermission('assetAudits.review'),
  auditLog('AssetAudit', 'RECOUNT'),
  requestAssetAuditRecount,
);
router.post(
  '/audits/:id/approve',
  requirePermission('assetAudits.approve'),
  auditLog('AssetAudit', 'APPROVE'),
  approveAssetAudit,
);
router.post(
  '/audits/:id/reject',
  requirePermission('assetAudits.review'),
  auditLog('AssetAudit', 'REJECT'),
  rejectAssetAudit,
);

router.get(
  '/depreciation-runs',
  requirePermission('assets.accounting'),
  listDepreciationRuns,
);
router.post(
  '/depreciation-runs',
  requirePermission('assets.accounting'),
  auditLog('AssetDepreciation', 'CREATE'),
  createDepreciationRun,
);
router.get(
  '/depreciation-runs/:id',
  requirePermission('assets.accounting'),
  getDepreciationRun,
);
router.post(
  '/depreciation-runs/:id/post',
  requirePermission('assets.accounting'),
  auditLog('AssetDepreciation', 'POST'),
  postDepreciationRun,
);

router.get('/reconciliation', requirePermission('assets.accounting'), getAssetReconciliation);

router.get('/', requirePermission('assets.view'), listAssets);
router.post(
  '/',
  requirePermission('assets.manage'),
  auditLog('Asset', 'CREATE'),
  createAsset,
);
router.get('/:id', requirePermission('assets.view'), getAsset);
router.put(
  '/:id',
  requirePermission('assets.manage'),
  auditLog('Asset', 'UPDATE'),
  updateAsset,
);
router.post(
  '/:id/transfer',
  requirePermission('assets.manage'),
  auditLog('Asset', 'TRANSFER'),
  transferAsset,
);
router.post(
  '/:id/deactivate',
  requirePermission('assets.manage'),
  auditLog('Asset', 'DEACTIVATE'),
  deactivateAsset,
);

export default router;
