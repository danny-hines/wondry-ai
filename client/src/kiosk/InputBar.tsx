export function InputBar({
  prompt,
  setPrompt,
  micLive,
  onSend,
  onMic,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  micLive: boolean;
  onSend: () => void;
  onMic: () => void;
}) {
  return (
    <div id="inputbar">
      <input
        id="prompt"
        value={prompt}
        placeholder="Ask me anything…  (type or tap 🎤)"
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSend();
        }}
      />
      <button id="mic" className={micLive ? 'live' : ''} title="Speak" onClick={() => onMic()}>
        🎤
      </button>
      <button id="send" onClick={() => onSend()}>
        Send
      </button>
    </div>
  );
}
