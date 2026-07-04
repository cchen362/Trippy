import { describe, it, expect } from 'vitest';
import { mergeDiscoveryCategories } from '../src/routes/discovery.js';

describe('mergeDiscoveryCategories', () => {
  it('appends new items into an existing matching category', () => {
    const existing = [{ category: 'culture', items: [{ name: 'Kinkakuji' }] }];
    const incoming = [{ category: 'culture', items: [{ name: 'Nijo Castle' }] }];

    const merged = mergeDiscoveryCategories(existing, incoming);

    expect(merged).toHaveLength(1);
    expect(merged[0].items.map((i) => i.name)).toEqual(['Kinkakuji', 'Nijo Castle']);
  });

  it('creates a new category entry when the incoming category does not exist yet', () => {
    const existing = [{ category: 'culture', items: [{ name: 'Kinkakuji' }] }];
    const incoming = [{ category: 'nightlife', items: [{ name: 'Pontocho Alley' }] }];

    const merged = mergeDiscoveryCategories(existing, incoming);

    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.category === 'nightlife').items.map((i) => i.name)).toEqual(['Pontocho Alley']);
  });

  it('dedupes incoming items against existing items by normalized name', () => {
    const existing = [{ category: 'hidden_gems', items: [{ name: 'Dujiangyan Scenic Area' }] }];
    // 'Dujiangyan & Scenic Area' normalizes to the same key as the existing item
    const incoming = [{ category: 'hidden_gems', items: [{ name: 'Dujiangyan & Scenic Area' }, { name: 'Nara Park' }] }];

    const merged = mergeDiscoveryCategories(existing, incoming);

    const items = merged.find((c) => c.category === 'hidden_gems').items;
    expect(items.map((i) => i.name)).toEqual(['Dujiangyan Scenic Area', 'Nara Park']);
  });

  it('dedupes incoming items against each other and across other existing categories', () => {
    const existing = [{ category: 'food', items: [{ name: 'Ramen Alley' }] }];
    const incoming = [
      { category: 'food', items: [{ name: 'Ramen Alley' }, { name: 'Noodle House' }] },
      { category: 'culture', items: [{ name: 'Noodle House' }] },
    ];

    const merged = mergeDiscoveryCategories(existing, incoming);

    expect(merged.find((c) => c.category === 'food').items.map((i) => i.name)).toEqual(['Ramen Alley', 'Noodle House']);
    // Second occurrence of "Noodle House" in a different category is dropped
    expect(merged.find((c) => c.category === 'culture')).toBeUndefined();
  });

  it('never removes existing items, even when the incoming batch is empty', () => {
    const existing = [{ category: 'culture', items: [{ name: 'Kinkakuji' }] }];

    const merged = mergeDiscoveryCategories(existing, []);

    expect(merged).toEqual([{ category: 'culture', items: [{ name: 'Kinkakuji' }] }]);
  });

  it('handles a null/undefined existing categories list (first generation)', () => {
    const incoming = [{ category: 'culture', items: [{ name: 'Kinkakuji' }] }];

    const merged = mergeDiscoveryCategories(null, incoming);

    expect(merged).toEqual([{ category: 'culture', items: [{ name: 'Kinkakuji' }] }]);
  });

  it('does not mutate the input arrays', () => {
    const existing = [{ category: 'culture', items: [{ name: 'Kinkakuji' }] }];
    const incoming = [{ category: 'culture', items: [{ name: 'Nijo Castle' }] }];
    const existingSnapshot = JSON.parse(JSON.stringify(existing));
    const incomingSnapshot = JSON.parse(JSON.stringify(incoming));

    mergeDiscoveryCategories(existing, incoming);

    expect(existing).toEqual(existingSnapshot);
    expect(incoming).toEqual(incomingSnapshot);
  });
});
