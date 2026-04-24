export default function CopilotMessage({ role, content, isStreaming }) {
  const isUser = role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 12,
      }}
    >
      <div
        style={{
          background: isUser ? '#232018' : '#1c1a17',
          color: isUser ? '#f0ead8' : 'rgba(240,234,216,0.60)',
          borderRadius: isUser ? '12px 12px 2px 12px' : '2px 12px 12px 12px',
          padding: '10px 14px',
          maxWidth: isUser ? '80%' : '85%',
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 15,
          lineHeight: 1.5,
          wordBreak: 'break-word',
        }}
      >
        {content}
        {isStreaming && (
          <span
            style={{
              animation: 'copilot-blink 1s step-end infinite',
              marginLeft: 2,
              color: '#c9a84c',
            }}
          >
            |
          </span>
        )}
      </div>
    </div>
  );
}
