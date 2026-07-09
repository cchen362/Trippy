import { describe, expect, it } from 'vitest';
import { dayDisplayLabel } from './dayGeo.js';

describe('dayDisplayLabel', () => {
  it('prefers the resolved city over the raw seed city', () => {
    expect(dayDisplayLabel({ resolvedCity: 'Kaohsiung City', city: 'Kaohsiung' })).toBe('Kaohsiung City');
  });

  it('falls back to the raw seed city when resolvedCity is absent', () => {
    expect(dayDisplayLabel({ city: 'Kaohsiung' })).toBe('Kaohsiung');
  });

  it('returns an empty string when neither is present', () => {
    expect(dayDisplayLabel({})).toBe('');
    expect(dayDisplayLabel(null)).toBe('');
    expect(dayDisplayLabel(undefined)).toBe('');
  });

  // MapTab previously prepended `cityOverride` ahead of `resolvedCity`/`city`,
  // which was redundant — resolvedCity already reflects any override. A day
  // with a cityOverride set must still resolve through resolvedCity alone.
  it('does not need a separate cityOverride branch — resolvedCity already reflects it', () => {
    expect(dayDisplayLabel({ cityOverride: 'Custom Name', resolvedCity: 'Custom Name', city: 'Original' })).toBe('Custom Name');
  });

  // AddPlaceModal previously had a reversed fallback chain (`city || resolvedCity`)
  // in one of its two usages, which would prefer the stale seed city over the
  // resolved one. The correct order — resolvedCity first — must hold.
  it('prefers resolvedCity over city even when both are present (order matters)', () => {
    expect(dayDisplayLabel({ city: 'Old Name', resolvedCity: 'New Resolved Name' })).toBe('New Resolved Name');
  });
});
