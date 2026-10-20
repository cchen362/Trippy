import { Fragment } from 'react';

// Non-interactive "Conditions" zone shared by the four booking cards. Every card root is a
// <button>, so this renders plain spans only. No gold: the card's one accent is already spent.
// Labels and values are direct grid children so the values of both lines align.
// D-37-15 (Plan 37): while a document is being read the zone leads with a "Reading" row, or "Still reading" once the wait ran long.
export default function CardConditions({ lines, variant = 'dossier', reading, arrived = false }) {
  const hasLines = Array.isArray(lines) && lines.length > 0;
  if (!hasLines && !reading) return null;
  const slow = reading === 'slow';
  return (
    <div className={`logistics-conditions logistics-conditions-${variant}${arrived ? ' facts-arrived' : ''}`}>
      {reading && (
        <>
          <span className="logistics-conditions-label facts-reading-label">
            {!slow && <span className="facts-reading-dot" aria-hidden="true" />}
            {slow ? 'Still reading' : 'Reading'}
          </span>
          <span className="logistics-conditions-value">{slow ? 'Conditions next visit' : 'Finding its conditions…'}</span>
        </>
      )}
      {hasLines && lines.map((line) => (
        <Fragment key={line.key}>
          <span className="logistics-conditions-label">{line.label}</span>
          <span className="logistics-conditions-value">{line.value}</span>
        </Fragment>
      ))}
    </div>
  );
}
