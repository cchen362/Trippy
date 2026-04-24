import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createBooking, deleteBooking, listBookings, updateBooking } from '../services/bookings.js';
import { requireTripAccess } from '../middleware/tripAccess.js';

const router = Router();

router.use(requireAuth);

router.get('/trips/:tripId/bookings', requireTripAccess, (req, res, next) => {
  try {
    res.json({ bookings: listBookings(req.user.id, req.params.tripId) });
  } catch (error) {
    next(error);
  }
});

router.post('/trips/:tripId/bookings', requireTripAccess, (req, res, next) => {
  createBooking(req.user.id, req.params.tripId, req.body)
    .then((booking) => res.status(201).json({ booking }))
    .catch(next);
});

router.patch('/bookings/:bookingId', (req, res, next) => {
  updateBooking(req.user.id, req.params.bookingId, req.body)
    .then((booking) => res.json({ booking }))
    .catch(next);
});

router.delete('/bookings/:bookingId', (req, res, next) => {
  try {
    res.json(deleteBooking(req.user.id, req.params.bookingId));
  } catch (error) {
    next(error);
  }
});

export default router;
