// Owed-row names are free text (`expense_owed.name`), so `Chee Loon` / `Cheeloon` /
// `CheeLoon` all refer to one person. Grouping, deduping, and people-counts compare on
// this normalized key; the first-entered spelling is always what gets displayed.
// This is a comparison key only — stored names are never rewritten.
export function normalizeOwedName(name) {
  return (name || '').toLowerCase().replace(/\s+/g, '');
}
