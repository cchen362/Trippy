import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import {
  createArtifactAndExtract,
  reextractArtifact,
  confirmArtifact,
  listArtifactsForTrip,
  getArtifactDetail,
  getArtifactFile,
  deleteArtifact,
} from '../services/importer.js';

const router = Router();
router.use(requireAuth);

router.post('/import/artifacts', (req, res, next) => {
  const { tripId, force, inputs } = req.body || {};
  createArtifactAndExtract(req.user.id, { tripId: tripId || null, inputs, force: Boolean(force) })
    .then((result) => res.status(201).json(result))
    .catch(next);
});

router.post('/import/artifacts/:id/extract', (req, res, next) => {
  reextractArtifact(req.user.id, req.params.id)
    .then((result) => res.status(200).json(result))
    .catch(next);
});

router.post('/import/artifacts/:id/confirm', (req, res, next) => {
  const { tripId, bookings } = req.body || {};
  confirmArtifact(req.user.id, req.params.id, { tripId, bookings })
    .then((result) => res.status(201).json(result))
    .catch(next);
});

router.get('/trips/:tripId/import/artifacts', requireTripAccess, (req, res, next) => {
  try {
    res.json({ artifacts: listArtifactsForTrip(req.user.id, req.params.tripId) });
  } catch (error) {
    next(error);
  }
});

router.get('/import/artifacts/:id', (req, res, next) => {
  try {
    res.json(getArtifactDetail(req.user.id, req.params.id));
  } catch (error) {
    next(error);
  }
});

router.get('/import/artifacts/:id/files/:position', (req, res, next) => {
  try {
    const file = getArtifactFile(req.user.id, req.params.id, req.params.position);
    res.set('Content-Type', file.media_type);
    res.set('Content-Disposition', `inline${file.filename ? `; filename="${file.filename}"` : ''}`);
    res.send(file.content);
  } catch (error) {
    next(error);
  }
});

router.delete('/import/artifacts/:id', (req, res, next) => {
  try {
    res.json(deleteArtifact(req.user.id, req.params.id));
  } catch (error) {
    next(error);
  }
});

export default router;
