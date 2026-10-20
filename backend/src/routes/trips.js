import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { listTripFacts, waitForTripReads } from '../services/documentFacts.js';
import { createTrip, deleteTrip, getTripDetail, listTripsForUser, updateTrip } from '../services/trips.js';

const router = Router();

router.use(requireAuth);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The longest a held facts request waits. A read measured 4-10.5 s; Cloudflare's 100 s no-bytes limit is far above this.
const FACTS_WAIT_MS = 30_000;

router.get('/', (req, res, next) => {
  try {
    // Plan 3 D1: the device clock is ground truth for the traveller, so "today" is
    // client-supplied. Server-local is the fallback, not the authority.
    const today = ISO_DATE.test(req.query.today || '') ? req.query.today : undefined;
    res.json({ trips: listTripsForUser(req.user.id, today ? { today } : undefined) });
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

// Plan 37: the conditions a trip's documents state (D-37-1). Private trip data, deliberately not part of /detail (D-37-7).
// D-37-15 (Plan 37): ?wait=1 holds the reply until this trip's reads settle (cap FACTS_WAIT_MS), so the reading indicator ends when the conditions exist; one held request, never a poll.
router.get('/:tripId/facts', requireTripAccess, async (req, res, next) => {
  try {
    if (req.query.wait === '1') {
      // res, not req: a GET's req 'close' can fire as soon as the request body is consumed (Node 16+).
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const { aborted } = await waitForTripReads(req.params.tripId, { timeoutMs: FACTS_WAIT_MS, signal: controller.signal });
      if (aborted) return;
    }
    res.json(listTripFacts(req.params.tripId));
  } catch (error) {
    next(error);
  }
});

router.patch('/:tripId', requireTripAccess, (req, res, next) => {
  try {
    res.json(updateTrip(req.user.id, req.params.tripId, req.body));
  } catch (error) {
    next(error);
  }
});

router.delete('/:tripId', requireTripAccess, (req, res, next) => {
  try {
    res.json(deleteTrip(req.user.id, req.params.tripId));
  } catch (error) {
    next(error);
  }
});

export default router;
