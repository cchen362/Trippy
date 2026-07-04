import rateLimit from 'express-rate-limit';

// Auth endpoints are the only public, unauthenticated surface — throttle by IP
// to blunt credential-stuffing / brute force against the login form.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
