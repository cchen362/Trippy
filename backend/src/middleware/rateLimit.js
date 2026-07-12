import rateLimit from 'express-rate-limit';

export const AUTH_RATE_LIMIT = process.env.NODE_ENV === 'test' ? 5 : 20;

// Auth endpoints are the only public, unauthenticated surface — throttle by IP
// to blunt credential-stuffing / brute force against the login form.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: AUTH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
