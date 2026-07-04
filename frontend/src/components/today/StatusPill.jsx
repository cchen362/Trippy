// Inert placeholder — the M3 extension point for the AeroDataBox flight-status
// refresh. Renders so the hero's pill row has a stable slot, but does nothing.
export default function StatusPill() {
  return (
    <span
      className="font-mono text-[11px] tracking-[0.2em] uppercase px-3 py-1 rounded-full border"
      style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-mute)', opacity: 0.5 }}
    >
      Status
    </span>
  );
}
