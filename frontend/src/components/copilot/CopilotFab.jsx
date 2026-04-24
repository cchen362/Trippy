export default function CopilotFab({ onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open co-pilot"
      style={{
        position: 'fixed',
        bottom: 80,
        right: 20,
        width: 52,
        height: 52,
        borderRadius: '50%',
        background: '#1c1a17',
        border: '1.5px solid rgba(201,168,76,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: 100,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M11 2C6.03 2 2 5.58 2 10c0 1.85.66 3.56 1.77 4.94L2 20l5.5-1.5C8.8 19.16 9.88 19.4 11 19.4 15.97 19.4 20 15.82 20 11.4 20 6.98 15.97 2 11 2z"
          stroke="#c9a84c"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
