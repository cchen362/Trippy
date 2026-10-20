import { FileText } from 'lucide-react';
import { tzAbbr } from './bookingCardUtils.js';
import { compareAtAsWritten, formatAtAsWritten } from './factFormat.js';

// D-37-13 (Plan 37): the primary kinds come first, in time order (undated last); instructions, allowances, contacts and cost lines stay grouped by kind under "Also in the document".
const PRIMARY_KINDS = ['deadline', 'window', 'requirement', 'restriction'];
const SECONDARY_KINDS = ['instruction', 'allowance', 'contact', 'cost_condition'];

// A kind neither list names sorts after the known ones rather than disappearing.
function kindRank(kinds, kind) {
  const i = kinds.indexOf(kind);
  return i === -1 ? kinds.length : i;
}

// Primary facts order by `at`, then kind, then original order; secondary facts stay grouped by
// kind, then `at`, then original order.
function orderFacts(facts, kinds, keep, timeFirst) {
  const compareAt = (a, b) => compareAtAsWritten(a.fact.at, b.fact.at);
  const compareKind = (a, b) => kindRank(kinds, a.fact.kind) - kindRank(kinds, b.fact.kind);
  const steps = timeFirst ? [compareAt, compareKind] : [compareKind, compareAt];
  return facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => keep(fact.kind))
    .sort((a, b) => {
      for (const step of steps) {
        const d = step(a, b);
        if (d !== 0) return d;
      }
      return a.index - b.index;
    })
    .map(({ fact }) => fact);
}

// D-37-10 (Plan 37): a time keeps its zone or says "zone not stated"; never converted.
function formatWhen(fact) {
  const when = formatAtAsWritten(fact.at);
  if (!when) return null;
  const { date, time } = when;
  if (!time) return date;
  let zone = null;
  if (fact.tz) zone = tzAbbr(fact.tz, fact.at) || fact.tz;
  else if (fact.tzSource === 'none') zone = 'zone not stated';
  return zone ? `${date} ${time} ${zone}` : `${date} ${time}`;
}

function pairedDocument(fact, documents) {
  const index = documents.findIndex((doc) => doc.key && doc.key === fact.document?.key);
  return { index, doc: index >= 0 ? documents[index] : null };
}

function documentName(fact, documents) {
  const { index, doc } = pairedDocument(fact, documents);
  if (doc) {
    return doc.filename || (doc.mediaType === 'application/pdf' ? `Document ${index + 1}` : `Photo ${index + 1}`);
  }
  return fact.document?.filename || '';
}

function sourceLabel(fact, withName, documents) {
  const isPdf = fact.document?.kind === 'pdf';
  const page = isPdf && fact.page ? String(fact.page) : '';
  const base = isPdf && fact.quoteVerified ? 'read from PDF' : 'read from image';
  const label = page ? `p.${page} · ${base}` : base;
  if (!withName) return label;
  const name = documentName(fact, documents);
  return name ? `${label} · ${name}` : label;
}

function FactRow({ fact, first, withName, documents, onOpenSource }) {
  const when = formatWhen(fact);
  const isText = fact.document?.kind === 'text';
  const isPdf = fact.document?.kind === 'pdf';
  const page = isPdf && fact.page ? String(fact.page) : null;

  const openSource = () => {
    const { doc } = pairedDocument(fact, documents);
    onOpenSource(
      doc || { url: fact.document?.url, mediaType: fact.document?.mediaType, filename: fact.document?.filename },
      page,
    );
  };

  return (
    <li className={first ? '' : 'border-t pt-4'} style={first ? undefined : { borderColor: 'var(--ink-border)' }}>
      <p className="font-mono text-[10px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
        {fact.label}
      </p>
      <p className="font-body text-lg" style={{ color: 'var(--cream)' }}>{fact.value}</p>
      {fact.quote && (
        <p className="font-body italic text-base" style={{ color: 'var(--cream-dim)' }}>
          {`“${fact.quote}”`}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tracking-[0.18em] uppercase">
        {when && <span style={{ color: 'var(--cream-mute)' }}>{when}</span>}
        {isText ? (
          // D-37-8 (Plan 37): a pasted confirmation has no viewer, so its source line is text.
          <span className="py-2" style={{ color: 'var(--cream-mute)' }}>from the pasted confirmation</span>
        ) : (
          <button
            type="button"
            onClick={openSource}
            className="py-2 inline-flex items-center gap-1.5 text-left"
            style={{ color: 'var(--cream-dim)' }}
          >
            <FileText size={12} />
            {sourceLabel(fact, withName, documents)}
          </button>
        )}
      </div>
    </li>
  );
}

function FactList({ facts, withName, documents, onOpenSource }) {
  return (
    <ul className="space-y-4">
      {facts.map((fact, i) => (
        <FactRow
          key={fact.id}
          fact={fact}
          first={i === 0}
          withName={withName}
          documents={documents}
          onOpenSource={onOpenSource}
        />
      ))}
    </ul>
  );
}

// D-37-15 (Plan 37): the wait is shown, with an honest expectation; "slow" says when the conditions will appear.
function ReadingRow({ reading, name, hasFacts }) {
  const slow = reading === 'slow';
  const line = slow
    ? 'Still reading'
    : name
      ? `Reading ${name} for its conditions…`
      : 'Reading the document for its conditions…';
  return (
    <div className={`facts-reading ${hasFacts ? 'mb-4' : ''}`}>
      <p className="font-mono text-[10px] tracking-[0.22em] uppercase inline-flex items-baseline gap-2" style={{ color: 'var(--cream-mute)' }}>
        {!slow && <span className="facts-reading-dot" aria-hidden="true" />}
        {line}
      </p>
      <p className="font-body italic text-base" style={{ color: 'var(--cream-dim)' }}>
        {slow
          ? 'This one is taking longer. Its conditions will show the next time you open Logistics.'
          : 'Usually under fifteen seconds.'}
      </p>
    </div>
  );
}

// D-37-14 (Plan 37): no display-side filter on fact content; reader 37.2 fixes schedule lines and cost lines inside a total at the source.
export default function BookingConditions({ facts, documents = [], onOpenSource, reading, readingName, arrived = false }) {
  const hasFacts = Array.isArray(facts) && facts.length > 0;
  if (!hasFacts && !reading) return null;

  const primary = hasFacts ? orderFacts(facts, PRIMARY_KINDS, (k) => PRIMARY_KINDS.includes(k), true) : [];
  const secondary = hasFacts ? orderFacts(facts, SECONDARY_KINDS, (k) => !PRIMARY_KINDS.includes(k), false) : [];
  const withName = hasFacts && new Set(facts.map((f) => f.document?.key)).size > 1;

  return (
    <div className="mt-4">
      <p className="font-mono text-xs tracking-[0.22em] uppercase mb-2" style={{ color: 'var(--cream-mute)' }}>Conditions</p>
      {/* aria-live is on the container so a screen reader hears the wait start and the list arrive. */}
      <div aria-live="polite" className={arrived ? 'facts-arrived' : undefined}>
        {reading && <ReadingRow reading={reading} name={readingName} hasFacts={hasFacts} />}
        {primary.length > 0 && (
          <FactList facts={primary} withName={withName} documents={documents} onOpenSource={onOpenSource} />
        )}
        {secondary.length > 0 && (
          <>
            {primary.length > 0 && (
              <p
                className="font-mono text-[10px] tracking-[0.22em] uppercase mt-6 mb-4 pt-5 border-t"
                style={{ color: 'var(--cream-mute)', borderColor: 'var(--ink-border)' }}
              >
                Also in the document
              </p>
            )}
            <FactList facts={secondary} withName={withName} documents={documents} onOpenSource={onOpenSource} />
          </>
        )}
      </div>
    </div>
  );
}
