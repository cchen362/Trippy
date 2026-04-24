import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireDayAccess } from '../middleware/tripAccess.js';
import { createStop, deleteStop, reorderStops, updateStop } from '../services/stops.js';

const router = Router();

router.use(requireAuth);

router.post('/days/:dayId/stops', requireDayAccess, (req, res, next) => {
  createStop(req.user.id, req.params.dayId, req.body)
    .then((stop) => res.status(201).json({ stop }))
    .catch(next);
});

router.post('/days/:dayId/stops/reorder', requireDayAccess, (req, res, next) => {
  try {
    const orderedStopIds = Array.isArray(req.body.orderedStopIds) ? req.body.orderedStopIds : [];
    const stops = reorderStops(req.user.id, req.params.dayId, orderedStopIds);
    res.json({ stops });
  } catch (error) {
    next(error);
  }
});

router.patch('/stops/:stopId', (req, res, next) => {
  updateStop(req.user.id, req.params.stopId, req.body)
    .then((stop) => res.json({ stop }))
    .catch(next);
});

router.delete('/stops/:stopId', (req, res, next) => {
  try {
    res.json(deleteStop(req.user.id, req.params.stopId));
  } catch (error) {
    next(error);
  }
});

export default router;
