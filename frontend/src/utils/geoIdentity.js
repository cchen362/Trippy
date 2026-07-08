// Mirrors backend/src/utils/geoIdentity.js — the two must be kept in lockstep.
// Folds a place label into a stable, punctuation-agnostic identity key so
// spelling/formatting variants of the same place ("Cheng Du", "Chengdu") and
// composite labels ("Kabupaten Badung, Bali") collapse to one canonical key.
export function canonicalGeoKey(label) {
  return String(label ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^\p{L}\p{N}]/gu, ''); // strip everything that isn't a Unicode letter/number
}
