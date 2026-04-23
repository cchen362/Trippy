import { Router } from 'express';
import * as authService from '../services/auth.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

const COOKIE_OPTS = (isProd) => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

router.get('/status', (req, res) => {
  res.json({ needsSetup: authService.needsSetup() });
});

router.post('/setup', (req, res, next) => {
  try {
    if (!authService.needsSetup()) return res.status(409).json({ error: 'Already set up' });
    const { username, password, displayName } = req.body;
    if (!username || !password || !displayName) return res.status(400).json({ error: 'Missing fields' });
    const { token, user } = authService.setup(username, password, displayName);
    res.cookie('auth_token', token, COOKIE_OPTS(process.env.NODE_ENV === 'production'));
    res.json({ user });
  } catch (err) { next(err); }
});

router.post('/register', (req, res, next) => {
  try {
    const { username, password, displayName, inviteCode } = req.body;
    if (!username || !password || !displayName || !inviteCode) return res.status(400).json({ error: 'Missing fields' });
    const { token, user } = authService.register(username, password, displayName, inviteCode);
    res.cookie('auth_token', token, COOKIE_OPTS(process.env.NODE_ENV === 'production'));
    res.json({ user });
  } catch (err) { next(err); }
});

router.post('/login', (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const { token, user } = authService.login(username, password);
    res.cookie('auth_token', token, COOKIE_OPTS(process.env.NODE_ENV === 'production'));
    res.json({ user });
  } catch (err) { next(err); }
});

router.post('/logout', requireAuth, (req, res) => {
  authService.logout(req.cookies.auth_token);
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Admin routes
router.get('/admin/invite-code', requireAdmin, (req, res) => {
  res.json({ inviteCode: authService.getInviteCode() });
});

router.post('/admin/invite-code', requireAdmin, (req, res) => {
  res.json({ inviteCode: authService.regenerateInviteCode() });
});

router.get('/admin/users', requireAdmin, (req, res) => {
  res.json({ users: authService.listUsers() });
});

router.delete('/admin/users/:userId', requireAdmin, (req, res, next) => {
  try {
    authService.deleteUser(req.params.userId, req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
