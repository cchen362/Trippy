import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createToken, listTokens, revokeToken } from '../services/integrationTokens.js';

const router = Router();

router.use(requireAuth);

// F-28-26: ?all=1 is honoured only for admins — a non-admin's ?all=1 is silently
// ignored rather than rejected, so the same request shape works whether or not
// the caller happens to be an admin.
router.get('/tokens', (req, res, next) => {
  try {
    const all = req.query.all === '1' && Boolean(req.user.is_admin);
    res.json({ tokens: listTokens(req.user.id, { all }) });
  } catch (error) {
    next(error);
  }
});

router.post('/tokens', (req, res, next) => {
  try {
    const { name, scopes, expiresInDays } = req.body;
    const result = createToken(req.user.id, { name, scopes, expiresInDays });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/tokens/:id', (req, res, next) => {
  try {
    const record = revokeToken(req.user.id, req.params.id, { isAdmin: Boolean(req.user.is_admin) });
    res.json({ token: record });
  } catch (error) {
    next(error);
  }
});

export default router;
