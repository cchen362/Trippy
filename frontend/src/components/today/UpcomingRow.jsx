import NavigateIcon from './NavigateIcon.jsx';

export default function UpcomingRow({ item, deepLinkProvider, dim = false }) {
  const title = item.booking?.title || item.stop?.title || 'Untitled';
  const lat = item.stop?.lat ?? null;
  const lng = item.stop?.lng ?? null;

  return (
    <div
      className="flex items-center gap-3 py-2.5"
      style={{ opacity: dim ? 0.45 : 1, borderBottom: '1px solid var(--ink-border)' }}
    >
      <span className="font-mono text-xs w-12 flex-shrink-0" style={{ color: 'var(--cream-mute)' }}>
        {item.time || ''}
      </span>
      <span className="font-body text-base flex-1 min-w-0 truncate" style={{ color: 'var(--cream)' }}>
        {title}
      </span>
      <NavigateIcon lat={lat} lng={lng} label={title} deepLinkProvider={deepLinkProvider} />
    </div>
  );
}
