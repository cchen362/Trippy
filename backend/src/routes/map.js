import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { getMapConfig } from '../services/mapConfig.js';

const router = Router();

router.get('/:tripId/map-config', requireAuth, requireTripAccess, (req, res, next) => {
  try {
    // req.trip is the raw DB row; destination_countries is a JSON-encoded column
    let destinationCountries = req.trip.destinationCountries;
    if (!Array.isArray(destinationCountries)) {
      try {
        destinationCountries = JSON.parse(req.trip.destination_countries || '[]');
      } catch {
        destinationCountries = [];
      }
    }

    const mapConfig = getMapConfig(destinationCountries);
    res.json({ mapConfig });
  } catch (error) {
    next(error);
  }
});

export default router;
