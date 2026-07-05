import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import UpcomingRow from './UpcomingRow.jsx';

export default function CollapsedRow({ items, deepLinkProvider, mapConfig }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between font-mono text-[11px] tracking-[0.2em] uppercase py-2"
        style={{ color: 'var(--cream-mute)' }}
      >
        <span>{items.length} earlier {items.length === 1 ? 'stop' : 'stops'}</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div>
          {items.map((item) => (
            <UpcomingRow key={`${item.kind}-${item.id}`} item={item} deepLinkProvider={deepLinkProvider} mapConfig={mapConfig} dim />
          ))}
        </div>
      )}
    </div>
  );
}
