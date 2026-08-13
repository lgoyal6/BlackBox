import type { ReactElement } from "react";
import type { Hit } from "@/lib/contracts";
import { formatScore, hitTitle, snippetLabel } from "./format";
import type { EmbeddingInfo } from "./incident-types";
import { Card, EmptyLine } from "./ui";
import { useScrollFade } from "./use-scroll-fade";
import type { RetrievalView } from "./view-state";

const MAX_ROWS = 3;

export function HitRow({ hit, showDivider }: { hit: Hit; showDivider: boolean }): ReactElement {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-[10px] ${showDivider ? "border-t border-bb-border" : ""}`}
    >
      <span className="truncate text-[15px] font-medium text-bb-text">{hitTitle(hit)}</span>
      {/* Tabular figures: these change live and a proportional 1 makes the right edge twitch. */}
      <span className="bb-tabular shrink-0 font-mono text-[15px] text-bb-muted-bright">
        {formatScore(hit.score)}
      </span>
    </div>
  );
}

export function RetrievedSnippet({ hit }: { hit: Hit }): ReactElement {
  return (
    <div className="mt-1 shrink-0 rounded-lg bg-bb-surface-2 p-[10px]">
      <p className="line-clamp-3 text-[15px] text-bb-muted-bright">
        <span className="font-semibold text-bb-text">{snippetLabel(hit)}</span> {hit.text}
      </p>
    </div>
  );
}

export function VectorSearchCard({
  retrieval,
  embedding,
}: {
  retrieval: RetrievalView | null;
  embedding: EmbeddingInfo | null;
}): ReactElement {
  const { ref: scrollRef, atEnd } = useScrollFade<HTMLDivElement>(
    `${retrieval?.hits.length ?? 0}:${retrieval?.primaryDocId ?? ""}`,
  );

  const aside =
    embedding !== null ? (
      <span className="bb-tabular shrink-0 font-mono text-sm text-bb-muted">
        {embedding.provider} · {embedding.dim}d
      </span>
    ) : undefined;

  if (retrieval === null || retrieval.hits.length === 0) {
    return (
      <Card title="Atlas vector search" aside={aside} className="min-h-0 flex-1 shrink">
        <EmptyLine>No retrieval yet</EmptyLine>
      </Card>
    );
  }

  const rows = retrieval.hits.slice(0, MAX_ROWS);
  // The expanded snippet is chosen by rrf, never by score: scores come from different
  // collections and are not comparable across sources, which is the whole reason rrf exists.
  const primary =
    retrieval.hits.find((h) => h.docId === retrieval.primaryDocId) ?? retrieval.hits[0];

  return (
    // This card is the flexible one in the right rail: it takes whatever height is left after
    // the phone and the pinned write counters, and scrolls inside itself rather than pushing
    // the counters off screen.
    <Card
      title="Atlas vector search"
      className="min-h-0 flex-1 shrink"
      aside={
        <span className="bb-tabular shrink-0 font-mono text-sm text-bb-muted">
          {retrieval.hits.length} hits
        </span>
      }
    >
      <div
        ref={scrollRef}
        data-at-end={atEnd}
        className="bb-scroll bb-fade-b min-h-0 flex-1 overflow-y-auto"
      >
        <div>
          {rows.map((hit, i) => (
            <HitRow key={hit.docId} hit={hit} showDivider={i > 0} />
          ))}
        </div>
        <RetrievedSnippet hit={primary} />
      </div>
    </Card>
  );
}
