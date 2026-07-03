import { request } from './api.js';

export const SIZE_CAPS = { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 100 * 1024 };
export const MAX_INPUTS = 4;

export const importApi = {
  createArtifact: ({ tripId, inputs, force }) =>
    request('/api/import/artifacts', {
      method: 'POST',
      body: { tripId: tripId || null, inputs, force: Boolean(force) },
      timeoutMs: 120000,
    }),
  reextract: (artifactId) =>
    request(`/api/import/artifacts/${artifactId}/extract`, { method: 'POST', timeoutMs: 120000 }),
  confirm: (artifactId, { tripId, bookings }) =>
    request(`/api/import/artifacts/${artifactId}/confirm`, {
      method: 'POST',
      body: { tripId, bookings },
      timeoutMs: 120000,
    }),
};

// FileReader → base64 (strips the "data:<mime>;base64," prefix). Rejects unsupported
// types/oversize up front so the UI fails fast with a specific message instead of a
// slow upload the backend would reject anyway.
export function fileToInput(file) {
  let kind;
  if (file.type === 'application/pdf') kind = 'pdf';
  else if (file.type.startsWith('image/')) kind = 'image';
  else return Promise.reject(new Error(`"${file.name}" isn't a supported file type — use an image or PDF.`));

  if (file.size === 0) {
    return Promise.reject(new Error(`"${file.name}" is empty.`));
  }
  if (file.size > SIZE_CAPS[kind]) {
    const capMb = SIZE_CAPS[kind] / (1024 * 1024);
    return Promise.reject(new Error(`"${file.name}" is too large — max ${capMb}MB for ${kind}s.`));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] || '';
      resolve({ kind, mediaType: file.type, filename: file.name, content: base64 });
    };
    reader.readAsDataURL(file);
  });
}

// Returns null for blank/whitespace text so callers can treat an empty textarea as
// "no text input" with one branch. Throws on oversize (caller surfaces the message).
export function textToInput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const sizeBytes = new Blob([trimmed]).size;
  if (sizeBytes > SIZE_CAPS.text) {
    throw new Error(`Pasted text is too large — max ${Math.floor(SIZE_CAPS.text / 1024)}KB.`);
  }
  return { kind: 'text', mediaType: 'text/plain', content: trimmed };
}
