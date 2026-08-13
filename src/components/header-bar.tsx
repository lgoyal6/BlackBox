import type { ReactElement } from "react";
import { DOT, sentenceCase } from "./format";
import { Pill, RecorderGlyph } from "./ui";
import type { HeaderView } from "./view-state";

export interface HeaderBarProps {
  header: HeaderView;
  recording: boolean;
}

function subtitleOf(header: HeaderView): string {
  const parts: string[] = [];
  if (header.label !== null) parts.push(sentenceCase(header.label));
  if (header.dispatchArea !== null) parts.push(`dispatch area ${header.dispatchArea}`);
  // Omit the unit segment and its separator entirely rather than rendering an empty tail.
  if (header.unit !== null) parts.push(`unit ${header.unit}`);
  return parts.join(DOT);
}

export function HeaderBar({ header, recording }: HeaderBarProps): ReactElement {
  const subtitle = subtitleOf(header);

  return (
    <header className="flex items-center justify-between gap-4 py-[18px]">
      <div className="flex min-w-0 items-start gap-3">
        <RecorderGlyph className="mt-[3px] shrink-0 text-bb-red" />
        <div className="min-w-0">
          {/* Rendered as one string so the layout does not jump when the first status lands. */}
          <h1 className="truncate text-[20px] font-semibold text-bb-text">
            {header.ref === null ? "Incident ——" : `Incident ${header.ref}`}
          </h1>
          <p className="truncate text-sm text-bb-muted">{subtitle || " "}</p>
        </div>
      </div>

      {recording ? <Pill tone="red">Recording</Pill> : null}
    </header>
  );
}
