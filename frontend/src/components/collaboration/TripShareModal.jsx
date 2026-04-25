import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import CollaboratorsPanel from './CollaboratorsPanel.jsx';
import ShareLinkCard from './ShareLinkCard.jsx';
import { useCollaboration } from '../../hooks/useCollaboration.js';

export default function TripShareModal({ tripId, onClose }) {
  const collaboration = useCollaboration(tripId);

  return (
    <motion.div
      className="fixed inset-0 z-[220] flex items-end sm:items-center justify-center px-0 sm:px-4"
      style={{ background: 'rgba(0,0,0,0.68)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="w-full sm:max-w-2xl max-h-[88vh] overflow-y-auto border rounded-t-2xl sm:rounded-2xl p-5 sm:p-6"
        style={{ background: 'var(--ink-mid)', borderColor: 'var(--ink-border)' }}
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 260 }}
      >
        <div className="flex items-center justify-between gap-3 mb-6">
          <div>
            <p className="font-mono text-[10px] tracking-[0.3em] uppercase" style={{ color: 'var(--cream-mute)' }}>
              Trip settings
            </p>
            <h1 className="font-display italic text-3xl" style={{ color: 'var(--cream)' }}>
              Share this itinerary
            </h1>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 inline-flex items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--ink-border)', color: 'var(--cream-dim)' }}
            aria-label="Close share settings"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {collaboration.loading ? (
          <p className="font-mono text-[11px] tracking-[0.22em] uppercase" style={{ color: 'var(--cream-mute)' }}>
            Loading people...
          </p>
        ) : (
          <div className="space-y-8">
            <CollaboratorsPanel
              owner={collaboration.owner}
              collaborators={collaboration.collaborators}
              canManage={collaboration.canManage}
              saving={collaboration.saving}
              error={collaboration.error}
              onInvite={collaboration.invite}
              onRemove={collaboration.remove}
            />
            <ShareLinkCard
              tripId={tripId}
              shareLink={collaboration.shareLink}
              saving={collaboration.saving}
              onCreateShare={collaboration.createShare}
            />
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
