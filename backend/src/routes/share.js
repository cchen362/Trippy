import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createShareLink, getSharedTrip } from '../services/share.js';

const router = Router();

router.post('/trips/:tripId/share', requireAuth, (req, res, next) => {
  try {
    res.json(createShareLink(req.user.id, req.params.tripId));
  } catch (error) {
    next(error);
  }
});

router.get('/share/:token', (req, res, next) => {
  try {
    res.json(getSharedTrip(req.params.token));
  } catch (error) {
    next(error);
  }
});

export default router;
