import { motion } from 'framer-motion';
import GoldRule from './GoldRule.jsx';

export default function LoadingScreen({ label = 'Loading journey...' }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--ink-deep)' }}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        <GoldRule className="mb-4" />
        <p className="font-mono text-xs tracking-[0.35em] uppercase mb-2" style={{ color: 'var(--gold)' }}>
          Trippy
        </p>
        <h1 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
          {label}
        </h1>
      </motion.div>
    </div>
  );
}
