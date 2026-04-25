import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  inviteCollaborator,
  listCollaborators,
  removeCollaborator,
} from '../services/collaboration.js';

const router = Router();

router.use(requireAuth);

router.get('/:tripId/collaborators', (req, res, next) => {
  try {
    res.json(listCollaborators(req.user.id, req.params.tripId));
  } catch (error) {
    next(error);
  }
});

router.post('/:tripId/collaborators', (req, res, next) => {
  try {
    const collaborator = inviteCollaborator(
      req.user.id,
      req.params.tripId,
      req.body.username,
    );
    res.status(201).json({ collaborator });
  } catch (error) {
    next(error);
  }
});

router.delete('/:tripId/collaborators/:userId', (req, res, next) => {
  try {
    res.json(removeCollaborator(req.user.id, req.params.tripId, req.params.userId));
  } catch (error) {
    next(error);
  }
});

export default router;
