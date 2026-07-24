export default function TabLoadingFallback() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <div className="text-center motion-reduce:animate-none animate-pulse">
        <div className="w-10 h-px mx-auto mb-3" style={{ background: 'var(--gold-line)' }} />
        <p className="font-mono text-[11px] tracking-[0.28em] uppercase" style={{ color: 'var(--cream-mute)' }}>
          Loading
        </p>
      </div>
    </div>
  );
}
