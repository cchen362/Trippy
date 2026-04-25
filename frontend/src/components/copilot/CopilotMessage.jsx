// Renders assistant markdown (bold, italic, headings, hr, inline code) and strips
// the trailing ```json mutation block (already shown as Proposed Changes card).
function renderMarkdown(text) {
  // Strip the last fenced JSON block — it's surfaced as the Proposed Changes card
  const stripped = text.replace(/```json[\s\S]*?```\s*$/, '').trimEnd();

  const lines = stripped.split('\n');
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line → spacing
    if (line.trim() === '') {
      elements.push(<div key={i} style={{ height: 6 }} />);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) {
      elements.push(
        <hr key={i} style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.08)', margin: '8px 0' }} />
      );
      i++;
      continue;
    }

    // Heading (## or ###)
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const fontSize = level === 1 ? 16 : level === 2 ? 14 : 13;
      elements.push(
        <div key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize, letterSpacing: '0.06em', color: '#f0ead8', marginTop: 10, marginBottom: 2 }}>
          {inlineRender(headingMatch[2])}
        </div>
      );
      i++;
      continue;
    }

    // Regular paragraph line
    elements.push(
      <div key={i} style={{ marginBottom: 1 }}>
        {inlineRender(line)}
      </div>
    );
    i++;
  }

  return elements;
}

function inlineRender(text) {
  // Split on bold (**text**), italic (*text*), inline code (`text`)
  const parts = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));

    if (match[0].startsWith('**')) {
      parts.push(<strong key={match.index} style={{ color: '#f0ead8', fontWeight: 700 }}>{match[2]}</strong>);
    } else if (match[0].startsWith('*')) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    } else {
      parts.push(
        <code key={match.index} style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4 }}>
          {match[4]}
        </code>
      );
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
}

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
          color: isUser ? '#f0ead8' : 'rgba(240,234,216,0.85)',
          borderRadius: isUser ? '12px 12px 2px 12px' : '2px 12px 12px 12px',
          padding: '10px 14px',
          maxWidth: isUser ? '80%' : '85%',
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: 15,
          lineHeight: 1.6,
          wordBreak: 'break-word',
        }}
      >
        {isUser ? content : renderMarkdown(content)}
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
