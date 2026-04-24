import { assertTripAccess, assertDayAccess } from '../services/trips.js';

export function requireTripAccess(req, res, next) {
  try {
    req.trip = assertTripAccess(req.user.id, req.params.tripId);
    next();
  } catch (error) {
    next(error);
  }
}

export function requireDayAccess(req, res, next) {
  try {
    req.day = assertDayAccess(req.user.id, req.params.dayId);
    next();
  } catch (error) {
    next(error);
  }
}
