import type { ReactElement, ReactNode } from "react";

// React 19 removed the global JSX namespace, so returns are annotated ReactElement.
// Both glyphs are inline SVG; this phase adds no icon package.

export interface CardProps {
  title: string;
  children: ReactNode;
  className?: string;
  /** Rendered at the card's top-right, opposite the title. */
  aside?: ReactNode;
}

export function Card({ title, children, className, aside }: CardProps): ReactElement {
  return (
    <section
      className={`flex flex-col rounded-xl border border-bb-border bg-bb-surface p-4 ${className ?? ""}`}
    >
      <div className="mb-[10px] flex items-center justify-between gap-3">
        <SectionLabel>{title}</SectionLabel>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function SectionLabel({ children }: { children: ReactNode }): ReactElement {
  return (
    <h2 className="text-sm font-medium tracking-[0.02em] text-bb-muted">{children}</h2>
  );
}

export interface PillProps {
  tone: "red" | "amber" | "neutral" | "neutral-strong";
  children: ReactNode;
  className?: string;
}

const PILL_TONES: Record<PillProps["tone"], string> = {
  red: "bg-bb-red-pill text-bb-red-pill-text",
  amber: "bg-bb-amber-surface text-bb-amber",
  neutral: "border border-bb-border-strong text-bb-muted",
  "neutral-strong": "border border-bb-muted bg-bb-surface-2 text-bb-text",
};

export function Pill({ tone, children, className }: PillProps): ReactElement {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-[10px] py-[3px] text-sm font-medium ${PILL_TONES[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

/**
 * Every card needs an empty state. In real mode the first twenty seconds of the demo are
 * nothing but empty states, and a card that renders as a floating title over a void reads
 * as a bug from the audience.
 */
export function EmptyLine({ children }: { children: ReactNode }): ReactElement {
  return <p className="text-sm text-bb-muted">{children}</p>;
}

export function RecorderGlyph({ className }: { className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect x="1.5" y="5" width="17" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.75" cy="10.5" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="13.25" cy="10.5" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 5V3.2h8V5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function CheckpointGlyph({ className }: { className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M3.5 1.75h5.5l3.5 3.5v9a.75.75 0 0 1-.75.75h-8.25a.75.75 0 0 1-.75-.75V2.5a.75.75 0 0 1 .75-.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 2v3.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path
        d="m5.75 10.25 1.6 1.6 3-3.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronGlyph({ className }: { className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="m4.5 2.5 3.5 3.5-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
