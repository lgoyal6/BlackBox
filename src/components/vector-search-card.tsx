import type { ReactElement } from "react";
import type { Hit } from "@/lib/contracts";
import { formatScore, hitTitle, snippetLabel } from "./format";
import type { EmbeddingInfo } from "./incident-types";
import { Card, EmptyLine } from "./ui";
import type { RetrievalView } from "./view-state";

const MAX_ROWS = 3;

export function HitRow({ hit, showDivider }: { hit: Hit; showDivider: boolean }): ReactElement {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-3 ${showDivider ? "border-t border-bb-border" : ""}`}
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
    <div className="mt-1 rounded-lg bg-bb-surface-2 p-3">
      <p className="line-clamp-4 text-[15px] text-bb-muted-bright">
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
  const aside =
    embedding !== null ? (
      <span className="bb-tabular shrink-0 font-mono text-sm text-bb-muted">
        {embedding.provider} · {embedding.dim}d
      </span>
    ) : undefined;

  if (retrieval === null || retrieval.hits.length === 0) {
    return (
      <Card title="Atlas vector search" aside={aside}>
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
    <Card
      title="Atlas vector search"
      aside={
        <span className="bb-tabular shrink-0 font-mono text-sm text-bb-muted">
          {retrieval.hits.length} hits
        </span>
      }
    >
      <div>
        {rows.map((hit, i) => (
          <HitRow key={hit.docId} hit={hit} showDivider={i > 0} />
        ))}
      </div>
      <RetrievedSnippet hit={primary} />
    </Card>
  );
}
