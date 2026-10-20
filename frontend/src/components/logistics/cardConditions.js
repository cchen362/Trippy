import { localIso } from '../../utils/date.js';
import { formatAtAsWritten } from './factFormat.js';

export function cardConditionLines(facts, today = localIso()) {
  // D-37-5 (Plan 37): a card shows at most the next deadline and the first window, no gold; the full list lives in the detail sheet.
  if (!Array.isArray(facts) || facts.length === 0) return [];

  const deadlines = facts
    .filter((f) => f.kind === 'deadline' && f.at && f.at.slice(0, 10) >= today)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const windows = facts
    .filter((f) => f.kind === 'window')
    .sort((a, b) => {
      if (!a.at && !b.at) return 0;
      if (!a.at) return 1;
      if (!b.at) return -1;
      return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
    });

  // A deadline's label already says what it is ("Free cancellation until"), so the card gives
  // its moment as written; the model's full sentence, with any qualifier, is in the sheet.
  const lines = [];
  if (deadlines[0]) {
    const when = formatAtAsWritten(deadlines[0].at);
    const value = when ? [when.date, when.time].filter(Boolean).join(' ') : deadlines[0].value;
    lines.push({ key: deadlines[0].id, label: deadlines[0].label, value });
  }
  if (windows[0]) lines.push({ key: windows[0].id, label: windows[0].label, value: windows[0].value });
  return lines;
}

// Screen-reader suffix: the card's aria-label hides its inner text, so the lines are spoken here.
export function conditionsAriaSuffix(lines) {
  return lines.map((l) => ` ${l.label}: ${l.value.replace(/[.\s]+$/, '')}.`).join('');
}
