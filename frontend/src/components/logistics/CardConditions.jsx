import { Fragment } from 'react';

// Non-interactive "Conditions" zone shared by the four booking cards. Every card root is a
// <button>, so this renders plain spans only. No gold: the card's one accent is already spent.
// Labels and values are direct grid children so the values of both lines align.
export default function CardConditions({ lines, variant = 'dossier' }) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return (
    <div className={`logistics-conditions logistics-conditions-${variant}`}>
      {lines.map((line) => (
        <Fragment key={line.key}>
          <span className="logistics-conditions-label">{line.label}</span>
          <span className="logistics-conditions-value">{line.value}</span>
        </Fragment>
      ))}
    </div>
  );
}
