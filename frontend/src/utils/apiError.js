// Maps a thrown request error (see services/api.js) to user-facing copy.
// Pure function: no DOM, no navigator, no imports.
export function friendlyError(err, context) {
  if (err?.code === 'NETWORK_ERROR' || err?.code === 'TIMEOUT') {
    return context === 'trips'
      ? "We can't load your trips right now. Check your connection and try again."
      : "Can't reach Trippy right now. Check your connection and try again.";
  }
  if (err?.status === 429) {
    return 'Too many attempts. Please wait before trying again.';
  }
  if (err?.status) {
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}
