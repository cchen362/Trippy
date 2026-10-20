// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DocumentViewer from './DocumentViewer.jsx';

afterEach(cleanup);

const pdf = { url: '/api/docs/1', mediaType: 'application/pdf', filename: 'Hotel.pdf' };
const image = { url: '/api/docs/2', mediaType: 'image/png', filename: 'Photo.png' };

describe('DocumentViewer — page fragment (Plan 37)', () => {
  it('opens a PDF at the page in the iframe and the new-tab link', () => {
    render(<DocumentViewer document={pdf} page="3" onClose={() => {}} />);
    expect(document.querySelector('iframe').getAttribute('src')).toBe('/api/docs/1#page=3');
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/docs/1#page=3');
    expect(pdf.url).toBe('/api/docs/1');
  });

  it('adds no fragment when no page is given', () => {
    render(<DocumentViewer document={pdf} page={null} onClose={() => {}} />);
    expect(document.querySelector('iframe').getAttribute('src')).toBe('/api/docs/1');
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/docs/1');
  });

  it('ignores the page for an image', () => {
    render(<DocumentViewer document={image} page="3" onClose={() => {}} />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/docs/2');
  });
});
