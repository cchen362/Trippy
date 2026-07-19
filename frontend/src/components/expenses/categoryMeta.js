import { Bed, Car, UtensilsCrossed, Compass, ShoppingBag, MoreHorizontal } from 'lucide-react';

// Fixed category set per the frozen contract — order here drives the sheet's
// category row and any category-grouped display.
export const EXPENSE_CATEGORIES = [
  { value: 'lodging', label: 'Lodging', Icon: Bed },
  { value: 'transport', label: 'Transport', Icon: Car },
  { value: 'food', label: 'Food', Icon: UtensilsCrossed },
  { value: 'activity', label: 'Activity', Icon: Compass },
  { value: 'shopping', label: 'Shopping', Icon: ShoppingBag },
  { value: 'other', label: 'Other', Icon: MoreHorizontal },
];

export function categoryMeta(category) {
  return EXPENSE_CATEGORIES.find((c) => c.value === category) ?? EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1];
}
