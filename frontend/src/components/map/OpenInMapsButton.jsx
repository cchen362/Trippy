export default function OpenInMapsButton({ lat, lng, label, deepLinkProvider }) {
  let href;
  let buttonLabel;

  if (deepLinkProvider === 'amap') {
    href = `https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(label)}`;
    buttonLabel = 'Open in Amap';
  } else if (deepLinkProvider === 'naver') {
    href = `https://map.naver.com/p/search/${encodeURIComponent(label)}?c=${lng},${lat},15,0,0,0,dh`;
    buttonLabel = 'Open in Naver Maps';
  } else {
    href = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    buttonLabel = 'Open in Google Maps';
  }

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
