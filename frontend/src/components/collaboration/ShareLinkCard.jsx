import { useMemo, useState } from 'react';
import { Copy, Link as LinkIcon, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

export default function ShareLinkCard({ tripId, shareLink, saving, onCreateShare }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = useMemo(() => {
    if (!shareLink?.token) return '';
    return `${window.location.origin}/share/${shareLink.token}`;
  }, [shareLink]);

  const handleCopy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard?.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.28em] uppercase" style={{ color: 'var(--gold)' }}>
            Share
          </p>
          <h2 className="font-display italic text-2xl" style={{ color: 'var(--cream)' }}>
            Read-only link
          </h2>
        </div>
        <QrCode size={22} style={{ color: 'var(--cream-mute)' }} />
      </div>

      {!shareUrl ? (
        <button
          type="button"
          onClick={onCreateShare}
          disabled={saving || !tripId}
          className="modal-action w-full"
          style={{ opacity: saving ? 0.55 : 1 }}
        >
          Create share link
        </button>
      ) : (
        <div className="grid sm:grid-cols-[144px,1fr] gap-4">
          <div
            className="w-36 h-36 rounded-xl flex items-center justify-center"
            style={{ background: 'var(--cream)' }}
          >
            <QRCodeSVG value={shareUrl} size={116} bgColor="#f0ead8" fgColor="#0d0b09" />
          </div>
          <div className="min-w-0">
            <div
              className="flex items-center gap-2 rounded-xl border px-3 py-3 mb-3"
              style={{ borderColor: 'var(--ink-border)', background: 'rgba(255,255,255,0.02)' }}
            >
              <LinkIcon size={16} style={{ color: 'var(--gold)', flexShrink: 0 }} />
              <p className="font-mono text-[11px] truncate" style={{ color: 'var(--cream-dim)' }}>
                {shareUrl}
              </p>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="modal-action inline-flex items-center justify-center gap-2"
            >
              <Copy size={15} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
