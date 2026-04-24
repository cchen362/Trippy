export default function GoldRule({ className = '' }) {
  return (
    <div
      className={className}
      style={{
        width: '20px',
        height: '1px',
        background: 'var(--gold)',
      }}
    />
  );
}
