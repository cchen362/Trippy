// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import BookingConditions from './BookingConditions.jsx';

afterEach(cleanup);

const doc = { key: 'artifactFile:1', kind: 'text', mediaType: 'text/plain', filename: '', url: null };
const fact = (id, kind, at) => ({ id, kind, label: `L-${id}`, value: `V-${id}`, quote: '', page: '', at, tz: '', tzSource: 'none', document: doc });

function order(facts) {
  const { container } = render(<BookingConditions facts={facts} documents={[]} onOpenSource={() => {}} />);
  return [...container.querySelectorAll('li')].map((li) => li.querySelector('p').textContent);
}

describe('BookingConditions ordering', () => {
  it('lists a dated window before a later deadline', () => {
    expect(order([
      fact('out', 'deadline', '2026-11-11T12:00'),
      fact('in', 'window', '2026-11-09T16:00'),
    ])).toEqual(['L-in', 'L-out']);
  });

  it('puts an undated requirement after dated primary facts', () => {
    expect(order([
      fact('req', 'requirement', ''),
      fact('out', 'deadline', '2026-11-11T12:00'),
      fact('in', 'window', '2026-11-09T16:00'),
    ])).toEqual(['L-in', 'L-out', 'L-req']);
  });

  it('breaks an equal time by kind rank', () => {
    expect(order([
      fact('w', 'window', '2026-11-09'),
      fact('d', 'deadline', '2026-11-09'),
    ])).toEqual(['L-d', 'L-w']);
  });

  it('keeps the secondary facts grouped by kind under "Also in the document"', () => {
    expect(order([
      fact('contact', 'contact', '2026-11-01'),
      fact('instr', 'instruction', '2026-12-01'),
      fact('instr2', 'instruction', '2026-11-05'),
      fact('in', 'window', '2026-11-09T16:00'),
    ])).toEqual(['L-in', 'L-instr2', 'L-instr', 'L-contact']);
  });
});
