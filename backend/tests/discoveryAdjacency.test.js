import { describe, it, expect } from 'vitest';
import { groupAdjacentNearMatches } from '../src/services/discoveryAdjacency.js';

function makeRow(name, overrides = {}) {
  return { name, ...overrides };
}

describe('groupAdjacentNearMatches — positive containment', () => {
  it('groups "Lotus Pond" with "Dragon and Tiger Pagodas (Lotus Pond)" even with unrelated rows between them', () => {
    const rows = [
      makeRow('Lotus Pond'),
      makeRow('Confucius Temple'),
      makeRow('Dragon and Tiger Pagodas (Lotus Pond)'),
    ];

    const result = groupAdjacentNearMatches(rows);
    const names = result.map((r) => r.name);

    // Lotus Pond's group (itself + the pagodas) starts at its own rank
    // position (0), pushing the unrelated row after the group.
    expect(names.indexOf('Lotus Pond')).toBe(0);
    expect(names.indexOf('Dragon and Tiger Pagodas (Lotus Pond)')).toBe(1);
    expect(names.indexOf('Confucius Temple')).toBe(2);
  });
});

describe('groupAdjacentNearMatches — negative case (the whole reason for containment over overlap)', () => {
  it('does NOT group "Kuala Lumpur War Cemetery" with "Kuala Lumpur Railway Station"', () => {
    const rows = [makeRow('Kuala Lumpur War Cemetery'), makeRow('Kuala Lumpur Railway Station')];

    const result = groupAdjacentNearMatches(rows);

    // Neither name's token set is a subset of the other's ("war"/"cemetery"
    // vs "railway"/"station" don't contain), so rank order is untouched.
    expect(result.map((r) => r.name)).toEqual(['Kuala Lumpur War Cemetery', 'Kuala Lumpur Railway Station']);
  });
});

describe('groupAdjacentNearMatches — transitive grouping', () => {
  it('groups three names via connected components even though the two longest are not near-matches of each other', () => {
    const rows = [
      makeRow('House of Matahari'),
      makeRow('Unrelated Museum'),
      makeRow('House of Matahari Crafts'),
      makeRow('House of Matahari Batik Workshops'),
    ];

    const result = groupAdjacentNearMatches(rows);
    const names = result.map((r) => r.name);

    expect(names.slice(0, 3).sort()).toEqual(
      ['House of Matahari', 'House of Matahari Crafts', 'House of Matahari Batik Workshops'].sort(),
    );
    expect(names[3]).toBe('Unrelated Museum');
  });
});

describe('groupAdjacentNearMatches — group position', () => {
  it('places a group at the rank position of its strongest (first-appearing) member', () => {
    const rows = [
      makeRow('Night Market'),
      makeRow('Lotus Pond'),
      makeRow('Old Temple'),
      makeRow('Dragon and Tiger Pagodas (Lotus Pond)'),
    ];

    const result = groupAdjacentNearMatches(rows);
    const names = result.map((r) => r.name);

    // Lotus Pond was 2nd overall (index 1) — its group must start there.
    expect(names[0]).toBe('Night Market');
    expect(names[1]).toBe('Lotus Pond');
    expect(names[2]).toBe('Dragon and Tiger Pagodas (Lotus Pond)');
    expect(names[3]).toBe('Old Temple');
  });
});

describe('groupAdjacentNearMatches — within-group order preserved', () => {
  it('keeps group members in their pre-existing ranked relative order', () => {
    const rows = [
      makeRow('House of Matahari'),
      makeRow('House of Matahari Batik Workshops'),
      makeRow('House of Matahari Crafts'),
    ];

    const result = groupAdjacentNearMatches(rows);

    expect(result.map((r) => r.name)).toEqual([
      'House of Matahari',
      'House of Matahari Batik Workshops',
      'House of Matahari Crafts',
    ]);
  });
});

describe('groupAdjacentNearMatches — empty-token guard', () => {
  it('never absorbs or is absorbed by other rows, and stays at its ranked position', () => {
    const rows = [makeRow('Lotus Pond'), makeRow('Scenic Area'), makeRow('Dragon and Tiger Pagodas (Lotus Pond)')];

    const result = groupAdjacentNearMatches(rows);
    const names = result.map((r) => r.name);

    // "Scenic Area" normalizes to "" and must stay a singleton, untouched
    // by the Lotus Pond group forming around it.
    expect(names).toEqual(['Lotus Pond', 'Dragon and Tiger Pagodas (Lotus Pond)', 'Scenic Area']);
  });

  it('leaves multiple empty-token rows as independent singletons, not grouped with each other', () => {
    const rows = [makeRow('Scenic Area'), makeRow('National Park'), makeRow('Old Town')];

    const result = groupAdjacentNearMatches(rows);

    expect(result.map((r) => r.name)).toEqual(['Scenic Area', 'National Park', 'Old Town']);
  });
});

describe('groupAdjacentNearMatches — conservation', () => {
  it('returns the same object identities with no drops or duplicates on a mixed fixture', () => {
    const rows = [
      makeRow('Lotus Pond'),
      makeRow('Confucius Temple'),
      makeRow('Kuala Lumpur War Cemetery'),
      makeRow('Dragon and Tiger Pagodas (Lotus Pond)'),
      makeRow('Scenic Area'),
      makeRow('Kuala Lumpur Railway Station'),
      makeRow('House of Matahari'),
      makeRow('House of Matahari Crafts'),
    ];

    const result = groupAdjacentNearMatches(rows);

    expect(result).toHaveLength(rows.length);
    // Every input row object appears exactly once, by reference.
    for (const row of rows) {
      expect(result.filter((r) => r === row)).toHaveLength(1);
    }
  });
});

describe('groupAdjacentNearMatches — no mutation', () => {
  it('leaves the input array order unchanged after the call', () => {
    const rows = [
      makeRow('Lotus Pond'),
      makeRow('Confucius Temple'),
      makeRow('Dragon and Tiger Pagodas (Lotus Pond)'),
    ];
    const originalOrder = rows.map((r) => r.name);

    groupAdjacentNearMatches(rows);

    expect(rows.map((r) => r.name)).toEqual(originalOrder);
  });
});

describe('groupAdjacentNearMatches — no-op case', () => {
  it('returns rows in exactly the same order when nothing near-matches', () => {
    const rows = [makeRow('Night Market'), makeRow('Old Temple'), makeRow('River Cruise')];

    const result = groupAdjacentNearMatches(rows);

    expect(result.map((r) => r.name)).toEqual(rows.map((r) => r.name));
    expect(result).not.toBe(rows);
  });
});
