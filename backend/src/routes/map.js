import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getMapConfigsForTrip } from '../services/mapData.js';
import { repairTripStopLocations } from '../services/stops.js';

const router = Router();

router.get('/:tripId/map-config', requireAuth, requireTripAccess, (req, res, next) => {
  try {
    // req.trip is the raw DB row from assertTripAccess. Top-level mapConfig keeps its
    // exact shape — this route is cached StaleWhileRevalidate for 7 days by the PWA
    // (vite.config.js) — mapConfigByDay is additive, ignored by pre-change clients.
    const { mapConfig, mapConfigByDay } = getMapConfigsForTrip(req.trip);
    res.json({ mapConfig, mapConfigByDay });
  } catch (error) {
    next(error);
  }
});

router.get('/:tripId/map-data', requireAuth, requireTripAccess, (req, res, next) => {
  try {
    res.json(getTripMapData(req.user.id, req.params.tripId));
  } catch (error) {
    next(error);
  }
});

router.post('/:tripId/repair-stop-locations', requireAuth, requireTripAccess, async (req, res, next) => {
  try {
    const result = await repairTripStopLocations(req.user.id, req.params.tripId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
