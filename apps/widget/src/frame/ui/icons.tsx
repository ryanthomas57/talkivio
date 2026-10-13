/** Inline stroke icons (24×24 grid, currentColor). Decorative: always aria-hidden. */
import type { JSX } from 'preact';

type P = { size?: number; class?: string };

function Svg({ size = 20, class: cls, children }: P & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M20 11.6c0 4.1-3.6 7.4-8 7.4-1.1 0-2.2-.2-3.2-.6L4 20l1.3-3.6C4.5 15.2 4 13.9 4 12.5 4 8.4 7.6 5 12 5s8 2.9 8 6.6Z" />
  </Svg>
);
export const IconMessage = (p: P) => (
  <Svg {...p}>
    <path d="M5 4.5h14A2 2 0 0 1 21 6.5v8.5a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
    <path d="M8 9.5h8M8 12.5h5" />
  </Svg>
);
export const IconHelp = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7" />
    <path d="M12 17.2h.01" />
  </Svg>
);
export const IconWave = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 11.5V6.8a1.5 1.5 0 0 1 3 0v4" />
    <path d="M10.5 10.5V5a1.5 1.5 0 0 1 3 0v5.5" />
    <path d="M13.5 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.6a5.8 5.8 0 0 1-4.3-1.9l-2.2-2.8a1.5 1.5 0 0 1 2.3-1.9l1.8 1.9v-3.8" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </Svg>
);
export const IconClip = (p: P) => (
  <Svg {...p}>
    <path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  </Svg>
);
export const IconSmile = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
  </Svg>
);
export const IconThumbUp = (p: P) => (
  <Svg {...p}>
    <path d="M7 10.5V20H4.5A1.5 1.5 0 0 1 3 18.5V12a1.5 1.5 0 0 1 1.5-1.5H7Zm0 0L11 3a2.5 2.5 0 0 1 2.5 2.5v4h5.2a2 2 0 0 1 2 2.3l-1.2 6.5a2 2 0 0 1-2 1.7H7" />
  </Svg>
);
export const IconThumbDown = (p: P) => (
  <Svg {...p}>
    <g transform="rotate(180 12 12)">
      <path d="M7 10.5V20H4.5A1.5 1.5 0 0 1 3 18.5V12a1.5 1.5 0 0 1 1.5-1.5H7Zm0 0L11 3a2.5 2.5 0 0 1 2.5 2.5v4h5.2a2 2 0 0 1 2 2.3l-1.2 6.5a2 2 0 0 1-2 1.7H7" />
    </g>
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const IconCheckDouble = (p: P) => (
  <Svg {...p}>
    <path d="m2.5 12.5 4.5 4.5 9-9.5M12 16l1 1 9-9.5" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5h.01" />
  </Svg>
);
export const IconFile = (p: P) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
  </Svg>
);
export const IconVolume = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Svg>
);
export const IconVolumeOff = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Svg>
);
export const IconMail = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
  </Svg>
);
export const IconEnd = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
