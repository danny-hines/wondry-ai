import type { RefObject } from 'react';

export function CornerControls({
  cornerRef,
  initials,
  trayCount,
  unseen,
  panelOpen,
  onSwitchUser,
  onTogglePanel,
}: {
  cornerRef: RefObject<HTMLDivElement>;
  initials: string;
  trayCount: number;
  unseen: number;
  panelOpen: boolean;
  onSwitchUser: () => void;
  onTogglePanel: () => void;
}) {
  return (
    <div id="corner" ref={cornerRef}>
      <span id="initials" title="Tap to switch user" onClick={onSwitchUser}>
        {initials}
      </span>
      <button
        id="trayBtn"
        className={trayCount === 0 ? 'empty' : ''}
        title={panelOpen ? 'Close' : 'My pages'}
        onClick={onTogglePanel}
      >
        {panelOpen ? (
          <span className="trayX" aria-hidden="true">
            ✕
          </span>
        ) : (
          <svg className="trayIcon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
            <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
            <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
            <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
          </svg>
        )}
        {!panelOpen && unseen > 0 && <span id="trayBadge">{unseen}</span>}
      </button>
    </div>
  );
}
