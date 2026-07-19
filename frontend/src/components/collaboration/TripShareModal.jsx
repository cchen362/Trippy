import CollaboratorsPanel from './CollaboratorsPanel.jsx';
import ShareLinkCard from './ShareLinkCard.jsx';
import { useCollaboration } from '../../hooks/useCollaboration.js';
import ModalShell from '../shell/ModalShell.jsx';

export default function TripShareModal({ tripId, onClose }) {
  const collaboration = useCollaboration(tripId);

  return (
    <ModalShell open onRequestClose={onClose} zBase={220} eyebrow="Trip settings" headline="Share this itinerary" maxWidth="2xl">
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
            onRevokeShare={collaboration.revokeShare}
          />
        </div>
      )}
    </ModalShell>
  );
}
