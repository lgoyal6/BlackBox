import type { ReactElement } from "react";
import { Card, EmptyLine } from "./ui";

export const WRITE_ORDER = [
  "decisions",
  "timeline",
  "postmortems",
  "remediations",
  "events",
] as const;
export const MAX_TILES = 4;

export function CounterTile({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="rounded-lg border border-bb-border bg-bb-surface-2 px-3 py-3">
      <p className="text-sm text-bb-muted">{label}</p>
      <p className="bb-tabular text-[28px] font-semibold text-bb-text">{value}</p>
    </div>
  );
}

export function WriteCounters({ writes }: { writes: Record<string, number> }): ReactElement {
  const tiles = WRITE_ORDER.filter((key) => Object.hasOwn(writes, key)).slice(0, MAX_TILES);

  if (tiles.length === 0) {
    return (
      <Card title="Writes this call">
        <EmptyLine>No writes yet</EmptyLine>
      </Card>
    );
  }

  return (
    <Card title="Writes this call">
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((key) => (
          <CounterTile key={key} label={key} value={writes[key] ?? 0} />
        ))}
      </div>
    </Card>
  );
}
