import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { createTrip, getTripDetail, listTripsForUser } from '../services/trips.js';

const router = Router();

router.use(requireAuth);

router.get('/', (req, res, next) => {
  try {
    res.json({ trips: listTripsForUser(req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.post('/', (req, res, next) => {
  try {
    res.status(201).json(createTrip(req.user.id, req.body));
  } catch (error) {
    next(error);
  }
});

router.get('/:tripId/detail', requireTripAccess, (req, res, next) => {
  try {
    res.json(getTripDetail(req.params.tripId, req.user.id));
  } catch (error) {
    next(error);
  }
});

export default router;
