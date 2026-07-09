import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  lookupFlightDetails,
  lookupHotelDetails,
  lookupHotelPredictions,
  lookupPlacePredictions,
  lookupDestinationPredictions,
  lookupDestinationBounds,
  lookupPhotos,
} from '../services/lookups.js';

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
    res.json({ suggestions: await lookupHotelPredictions(req.query.q, req.query.sessionToken) });
  } catch (error) {
    next(error);
  }
});

router.get('/places/search', async (req, res, next) => {
  try {
    res.json({
      suggestions: await lookupPlacePredictions(req.query.q, req.query.sessionToken, req.query.near),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/places/:placeId', async (req, res, next) => {
  try {
    res.json({ place: await lookupHotelDetails(req.params.placeId, req.query.sessionToken) });
  } catch (error) {
    next(error);
  }
});

router.get('/destinations', async (req, res, next) => {
  try {
    res.json({ suggestions: await lookupDestinationPredictions(req.query.q, req.query.sessionToken) });
  } catch (error) {
    next(error);
  }
});

router.get('/destination-bounds', async (req, res, next) => {
  try {
    if (!req.query.placeId) {
      throw Object.assign(new Error('placeId is required'), { status: 400 });
    }
    res.json(await lookupDestinationBounds(req.query.placeId, req.query.sessionToken));
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
