// Conservative suffix strip for hotel display names — used only on the
// autocomplete-suggestion fallback path, when a Place Details response carries
// no official `name`. Suggestion text can carry a trailing locality suffix
// (e.g. "Hotel Indigo Kaohsiung Sinsing District"). We only ever strip a
// suffix when it exactly matches one of the place's own address components
// token-for-token — never on a partial/substring match — so we can't corrupt
// a name that merely mentions a place name mid-string (e.g. "W Bali - Seminyak").
export function stripComponentSuffix(name, components) {
  if (!name) return name;
  const candidates = (components || []).filter(Boolean);
  if (candidates.length === 0) return name;

  const nameTokens = name.trim().split(/\s+/);

  let bestMatchLength = 0;
  for (const component of candidates) {
    const componentTokens = component.trim().split(/\s+/).filter(Boolean);
    if (componentTokens.length === 0 || componentTokens.length > nameTokens.length) continue;
    const trailing = nameTokens.slice(nameTokens.length - componentTokens.length);
    const isExactMatch = trailing.every(
      (token, i) => token.toLowerCase() === componentTokens[i].toLowerCase(),
    );
    if (isExactMatch && componentTokens.length > bestMatchLength) {
      bestMatchLength = componentTokens.length;
    }
  }

  if (bestMatchLength === 0) return name;

  const stripped = nameTokens.slice(0, nameTokens.length - bestMatchLength).join(' ').trim();
  return stripped || name;
}
