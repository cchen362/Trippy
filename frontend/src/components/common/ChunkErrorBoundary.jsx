import { Component } from 'react';

function ReloadFallback({ variant }) {
  const isFull = variant === 'full';

  return (
    <div
      className={
        isFull
          ? 'min-h-screen flex items-center justify-center px-6'
          : 'min-h-[40vh] flex items-center justify-center px-6 py-16'
      }
      style={isFull ? { background: 'var(--ink-deep)' } : undefined}
    >
      <div className="w-full max-w-sm text-center">
        <p className="font-mono text-xs tracking-[0.35em] uppercase mb-3" style={{ color: 'var(--gold)' }}>
          Couldn't load
        </p>
        <p className="font-body text-lg mb-6" style={{ color: 'var(--cream-dim)' }}>
          This part of Trippy didn't load. Reloading usually fixes it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="font-mono text-xs tracking-[0.28em] uppercase px-6 py-3 rounded-full border"
          style={{ borderColor: 'var(--gold-line)', color: 'var(--gold)', background: 'var(--gold-soft)' }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}

export default class ChunkErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error('Chunk/render error caught by boundary:', error);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return <ReloadFallback variant={this.props.variant ?? 'full'} />;
    }
    return this.props.children;
  }
}
