// Suite-wide stub for the document-read kick (Plan 37, D-37-3), loaded beside noNetwork.js for the unit
// project. writeAttachment (every manual and MCP upload) and confirmArtifact (every import confirm) now
// start a background read of the stored document. Most test files add attachments or confirm imports to
// test something else entirely, so without this each of them would queue a model call that runs past the
// test that started it, reads rows another test then asserts on, and, with a real backend/.env key
// loaded, sends a request the network guard records and fails.
//
// Only kickDocumentReads is stubbed; the enumeration, the job's internals and the read-back stay real.
// A test of the job itself opts back in with `vi.unmock('../src/services/documentFacts.js')`
// (tests/documentFacts.test.js).
import { vi } from 'vitest';

vi.mock('../../src/services/documentFacts.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, kickDocumentReads: vi.fn() };
});
