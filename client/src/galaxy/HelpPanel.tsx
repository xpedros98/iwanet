import { useEffect, type ReactNode } from 'react';

/**
 * "How to move around": one small drawing per gesture. The drawings are
 * inline SVG (no image files) in the panel's text colour, with the active
 * part (button, wheel, finger) in the accent colour.
 */

const ACCENT = '#7fa8ff';

/** Mouse outline; `part` is highlighted. */
function Mouse({ part }: { part: 'left' | 'right' | 'wheel' }) {
  return (
    <g>
      <rect x="20" y="10" width="28" height="44" rx="14" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="34" y1="10" x2="34" y2="28" stroke="currentColor" strokeWidth="2" />
      <line x1="20" y1="28" x2="48" y2="28" stroke="currentColor" strokeWidth="2" />
      {part === 'left' && <path d="M34 11 A13 13 0 0 0 21 24 V27 H33 V11 Z" fill={ACCENT} />}
      {part === 'right' && <path d="M35 11 A13 13 0 0 1 47 24 V27 H35 V11 Z" fill={ACCENT} />}
      <rect x="31" y="15" width="6" height="9" rx="3" fill={part === 'wheel' ? ACCENT : 'currentColor'} />
    </g>
  );
}

const Arrow = ({ d }: { d: string }) => (
  <path d={d} fill="none" stroke={ACCENT} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
);

const pics: Record<string, ReactNode> = {
  rotate: (
    <>
      <Mouse part="left" />
      <Arrow d="M6 36 Q2 26 8 18 M8 18 l-4 1 M8 18 l1 4" />
      <Arrow d="M62 36 Q66 26 60 18 M60 18 l4 1 M60 18 l-1 4" />
    </>
  ),
  zoom: (
    <>
      <Mouse part="wheel" />
      <Arrow d="M60 14 v14 M56 18 l4 -4 l4 4" />
      <Arrow d="M60 36 v14 M56 46 l4 4 l4 -4" />
    </>
  ),
  pan: (
    <>
      <Mouse part="right" />
      <Arrow d="M4 32 h12 M8 28 l-4 4 l4 4" />
      <Arrow d="M52 32 h12 M60 28 l4 4 l-4 4" />
    </>
  ),
  click: (
    <>
      <circle cx="40" cy="22" r="3.5" fill={ACCENT} />
      <circle cx="40" cy="22" r="8" fill="none" stroke={ACCENT} strokeWidth="1.2" opacity="0.6" />
      <circle cx="18" cy="14" r="1.6" fill="currentColor" />
      <circle cx="56" cy="44" r="1.6" fill="currentColor" />
      <circle cx="12" cy="48" r="1.2" fill="currentColor" />
      <path d="M30 32 L30 54 L35 49 L39 58 L43 56 L39 47 L46 47 Z" fill="currentColor" />
    </>
  ),
  edge: (
    <>
      <rect x="4" y="10" width="60" height="42" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="54" y="11" width="9" height="40" fill={ACCENT} opacity="0.25" />
      <path d="M56 26 L56 40 L59.5 37 L62 42 L64 41 L61.5 36 L66 36 Z" fill="currentColor" />
      <Arrow d="M14 31 Q34 22 48 31 M48 31 l-5 -1 M48 31 l-2 -4" />
    </>
  ),
  flick: (
    <>
      <Mouse part="left" />
      <Arrow d="M50 32 h14 M60 28 l4 4 l-4 4" />
      <path d="M52 22 h6 M50 42 h8" stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
    </>
  ),
  touch: (
    <>
      <rect x="18" y="4" width="32" height="56" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="28" cy="34" r="4" fill={ACCENT} />
      <circle cx="40" cy="26" r="4" fill={ACCENT} />
      <Arrow d="M24 38 l-5 5 M44 22 l5 -5" />
    </>
  ),
};

const ITEMS: { pic: keyof typeof pics; title: string; text: string }[] = [
  { pic: 'rotate', title: 'Rotate', text: 'Drag with the left button.' },
  { pic: 'zoom', title: 'Zoom', text: 'Scroll the wheel. It zooms toward the cursor.' },
  { pic: 'pan', title: 'Move sideways', text: 'Drag with the right button.' },
  { pic: 'click', title: 'Visit a star', text: 'Click a star to fly to it. Hover to see its name.' },
  { pic: 'edge', title: 'Turn', text: 'Rest the mouse near the left or right edge.' },
  { pic: 'flick', title: 'Spin', text: 'Drag and let go while moving: it keeps turning.' },
  { pic: 'touch', title: 'Touch screens', text: 'One finger rotates, two fingers pinch to zoom and move.' },
];

export function HelpPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <section className="galaxy-help" role="dialog" aria-label="How to move around">
      <header>
        <h2>How to move around</h2>
        <button type="button" onClick={onClose} aria-label="Close help">
          ×
        </button>
      </header>
      <ul>
        {ITEMS.map((it) => (
          <li key={it.pic}>
            <svg viewBox="0 0 68 62" width="68" height="62" aria-hidden="true">
              {pics[it.pic]}
            </svg>
            <div>
              <strong>{it.title}</strong>
              <span>{it.text}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="galaxy-help-foot">
        <b>My star</b> flies back to you. <b>Rotation</b> sets how fast the galaxy turns by itself (double-click it to reset).
      </p>
    </section>
  );
}
