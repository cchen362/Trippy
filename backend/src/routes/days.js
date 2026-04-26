import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { listDaysForTrip, updateDayCityOverride } from '../services/trips.js';

const router = Router();

router.use(requireAuth);

router.get('/trips/:tripId/days', requireTripAccess, (req, res, next) => {
  try {
    res.json({ days: listDaysForTrip(req.params.tripId, req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.patch('/trips/:tripId/days/:date', requireTripAccess, (req, res, next) => {
  try {
    const { cityOverride } = req.body;
    const normalized = cityOverride == null ? null : String(cityOverride).trim() || null;
    res.json(updateDayCityOverride(req.user.id, req.params.tripId, req.params.date, normalized));
  } catch (err) {
    next(err);
  }
});

export default router;
