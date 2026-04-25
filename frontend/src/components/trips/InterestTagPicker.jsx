const TAGS = [
  'Food & Drink',
  'Nature',
  'Culture',
  'Nightlife',
  'Wellness',
  'Markets',
  'Architecture',
  'History',
  'Adventure',
  'Art',
  'Shopping',
  'Off the beaten path',
];

export default function InterestTagPicker({ selected, onChange }) {
  const toggle = (tag) => {
    onChange(
      selected.includes(tag)
        ? selected.filter((t) => t !== tag)
        : [...selected, tag],
    );
  };

  return (
    <div className="sm:col-span-2">
      <span
        className="font-mono text-[11px] tracking-[0.22em] uppercase mb-3 block"
        style={{ color: 'var(--cream-mute)' }}
      >
        Interests
      </span>
      <div className="flex flex-wrap gap-2">
        {TAGS.map((tag) => {
          const active = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className="px-3 py-1.5 rounded-full font-mono text-[11px] tracking-[0.22em] uppercase transition-colors"
              style={{
                background: 'var(--ink-mid)',
                border: `1px solid ${active ? 'var(--gold)' : 'var(--ink-border)'}`,
                color: active ? 'var(--gold)' : 'var(--cream-mute)',
              }}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}
