import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getMapConfig } from '../services/mapConfig.js';

const router = Router();

router.get('/:tripId/map-config', requireAuth, requireTripAccess, (req, res, next) => {
  try {
    // req.trip is the raw DB row from assertTripAccess; destination_countries is a JSON text column
    const destinationCountries = JSON.parse(req.trip.destination_countries || '[]');
    const mapConfig = getMapConfig(destinationCountries);
    res.json({ mapConfig });
  } catch (error) {
    next(error);
  }
});

export default router;
