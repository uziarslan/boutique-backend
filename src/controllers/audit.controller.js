import AuditLog from '../models/AuditLog.js';
import { resolveTimezone, localDateRange } from '../utils/timezone.js';

// GET /api/audit-logs — owner-only activity trail.
// Query: page, limit, module, action, source, userId, from, to (YYYY-MM-DD), search
export const listAuditLogs = async (req, res) => {
  const pageNum = Math.max(1, parseInt(req.query.page ?? 1, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.limit ?? 30, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = {};
  if (req.query.module) filter.module = req.query.module;
  if (req.query.source) filter.source = req.query.source;
  if (req.query.action) filter.action = req.query.action;
  if (req.query.userId && /^[a-f\d]{24}$/i.test(req.query.userId)) filter.user = req.query.userId;

  if (req.query.from || req.query.to) {
    const tz = await resolveTimezone();
    filter.timestamp = localDateRange(req.query.from, req.query.to, tz);
  }

  if (req.query.search) {
    const q = String(req.query.search).trim();
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = { $regex: safe, $options: 'i' };
      filter.$or = [
        { actorName: re },
        { action: re },
        { path: re },
        { module: re },
      ];
    }
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('user', 'name email role')
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  const rows = logs.map((l) => ({
    _id: l._id,
    timestamp: l.timestamp,
    actorName: l.actorName || l.user?.name || l.user?.email || 'System',
    actorRole: l.actorRole || l.user?.role || null,
    action: l.action,
    module: l.module,
    method: l.method || null,
    path: l.path || null,
    statusCode: l.statusCode ?? null,
    source: l.source || 'action',
    recordId: l.recordId || null,
    ip: l.ip || null,
    device: l.device || null,
    location: l.location || null,
    before: l.before ?? null,
    after: l.after ?? null,
  }));

  // Distinct module list for the filter dropdown (cheap on indexed field).
  const modules = await AuditLog.distinct('module');

  return res.json({
    success: true,
    data: {
      logs: rows,
      modules: modules.filter(Boolean).sort(),
      pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
    },
  });
};
