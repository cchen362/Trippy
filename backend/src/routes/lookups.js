import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { lookupFlightDetails, lookupHotelPredictions, lookupPhotos } from '../services/lookups.js';

const router = Router();

router.use(requireAuth);

router.get('/photos', async (req, res, next) => {
  try {
    res.json({ photos: await lookupPhotos(req.query.q) });
  } catch (error) {
    next(error);
  }
});

router.get('/places/hotels', async (req, res, next) => {
  try {
    res.json({ suggestions: await lookupHotelPredictions(req.query.q) });
  } catch (error) {
    next(error);
  }
});

router.get('/flights', async (req, res, next) => {
  try {
    res.json({
      flight: await lookupFlightDetails({
        carrierCode: req.query.carrierCode,
        flightNumber: req.query.flightNumber,
        flightQuery: req.query.flightQuery,
        departureDate: req.query.departureDate,
      }),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
