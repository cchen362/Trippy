import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { listDaysForTrip, listBookingsForTrip, updateDayCityOverride } from '../services/trips.js';

const router = Router();

router.use(requireAuth);

router.get('/trips/:tripId/days', requireTripAccess, (req, res, next) => {
  try {
    // Load bookings first so listDaysForTrip's derivation runs the full five-layer
    // precedence (not just override → previous → seed) — ending the split where this
    // endpoint's resolvedCity used to disagree with getTripDetail's (review §1.1).
    const bookings = listBookingsForTrip(req.params.tripId);
    res.json({ days: listDaysForTrip(req.params.tripId, req.user.id, bookings) });
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
