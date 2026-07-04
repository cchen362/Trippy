import { buildDeepLink } from '../../utils/deepLink.js';

export default function OpenInMapsButton({ lat, lng, label, deepLinkProvider }) {
  const href = buildDeepLink(deepLinkProvider, lat, lng, label);
  const buttonLabel =
    deepLinkProvider === 'amap' ? 'Open in Amap' :
    deepLinkProvider === 'naver' ? 'Open in Naver Maps' :
    'Open in Google Maps';

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-block',
        border: '1px solid rgba(201,168,76,0.5)',
        color: 'rgba(201,168,76,1)',
        fontFamily: "'DM Mono', monospace",
        fontSize: 11,
        padding: '4px 10px',
        borderRadius: 999,
        textDecoration: 'none',
      }}
    >
      {buttonLabel}
    </a>
  );
}
