import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireTripAccess } from '../middleware/tripAccess.js';
import { createExpense, deleteExpense, listExpenses, setOwedSettled, updateExpense } from '../services/expenses.js';

const router = Router();

router.use(requireAuth);

router.get('/trips/:tripId/expenses', requireTripAccess, (req, res, next) => {
  try {
    res.json(listExpenses(req.user.id, req.params.tripId));
  } catch (error) {
    next(error);
  }
});

router.post('/trips/:tripId/expenses', requireTripAccess, (req, res, next) => {
  try {
    const result = createExpense(req.user.id, req.params.tripId, req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.patch('/trips/:tripId/expenses/:expenseId', requireTripAccess, (req, res, next) => {
  try {
    res.json(updateExpense(req.user.id, req.params.tripId, req.params.expenseId, req.body));
  } catch (error) {
    next(error);
  }
});

router.delete('/trips/:tripId/expenses/:expenseId', requireTripAccess, (req, res, next) => {
  try {
    res.json(deleteExpense(req.user.id, req.params.tripId, req.params.expenseId));
  } catch (error) {
    next(error);
  }
});

router.patch('/trips/:tripId/expenses/:expenseId/owed/:owedId', requireTripAccess, (req, res, next) => {
  try {
    const { settled } = req.body || {};
    if (typeof settled !== 'boolean') {
      throw Object.assign(new Error('settled must be a boolean'), { status: 400 });
    }
    res.json(setOwedSettled(req.user.id, req.params.tripId, req.params.expenseId, req.params.owedId, settled));
  } catch (error) {
    next(error);
  }
});

export default router;
