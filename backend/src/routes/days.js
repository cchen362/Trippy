import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { listDaysForTrip } from '../services/trips.js';

const router = Router();

router.use(requireAuth);

router.get('/trips/:tripId/days', requireTripAccess, (req, res, next) => {
  try {
    res.json({ days: listDaysForTrip(req.params.tripId, req.user.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
