import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import { createManualRetailProduct } from '../controllers/retailCatalog.controller.js';
import {
  connectShopify,
  retryShopifyTask,
  cancelShopifyTask,
  cancelShopifyCatalogSync,
  editRetailBarcode,
  editRetailProduct,
  getShopifyEvents,
  getShopifyInventoryConflicts,
  getShopifyLocations,
  getShopifySettings,
  getRetailProduct,
  receiveShopifyWebhook,
  registerShopifyWebhooks,
  saveShopifyLocationMappings,
  searchBoutiqueCatalog,
  syncShopifyCatalog,
  retryShopifyEvent,
  retryShopifyInventoryMovement,
  reconcileShopifyOrders,
} from '../controllers/shopify.controller.js';

export const shopifyWebhookRouter = Router();
shopifyWebhookRouter.post('/', receiveShopifyWebhook);

const router = Router();
const ownerOrIntegrationManager = allowRoleOrPermission(['owner', 'financeManager'], 'settings.integrations');

router.post('/tasks/:taskId/retry', protect, ownerOrIntegrationManager, retryShopifyTask);
router.post('/tasks/:taskId/cancel', protect, ownerOrIntegrationManager, cancelShopifyTask);
router.get('/settings', protect, ownerOrIntegrationManager, getShopifySettings);
router.post('/connect', protect, ownerOrIntegrationManager, connectShopify);
router.post('/webhooks/register', protect, ownerOrIntegrationManager, registerShopifyWebhooks);
router.get('/locations', protect, ownerOrIntegrationManager, getShopifyLocations);
router.put('/mappings', protect, ownerOrIntegrationManager, saveShopifyLocationMappings);
router.post('/catalog/sync', protect, ownerOrIntegrationManager, syncShopifyCatalog);
router.post('/catalog/sync/cancel', protect, ownerOrIntegrationManager, cancelShopifyCatalogSync);
router.post('/orders/reconcile', protect, ownerOrIntegrationManager, reconcileShopifyOrders);
router.get('/events', protect, ownerOrIntegrationManager, getShopifyEvents);
router.post('/events/:eventId/retry', protect, ownerOrIntegrationManager, retryShopifyEvent);
router.get('/inventory-conflicts', protect, ownerOrIntegrationManager, getShopifyInventoryConflicts);
router.post('/inventory-conflicts/:movementId/retry', protect, ownerOrIntegrationManager, retryShopifyInventoryMovement);
router.get('/catalog', protect, searchBoutiqueCatalog);
router.post('/catalog/manual', protect, requirePermission('inventory.manage'), createManualRetailProduct);
router.get('/catalog/products/:productId', protect, requirePermission('inventory.manage'), getRetailProduct);
router.put('/catalog/products/:productId', protect, requirePermission('inventory.manage'), editRetailProduct);
router.patch('/variants/:variantId/barcode', protect, allowRoleOrPermission(['owner', 'financeManager'], 'inventory.manage'), editRetailBarcode);

export default router;
