declare module "@/lib/embeddings" {
  import type { EmbeddingsPort } from "@/lib/ports";
  const impl: EmbeddingsPort;
  export default impl;
}

declare module "@/lib/retrieval" {
  import type { RetrievalPort } from "@/lib/ports";
  const impl: RetrievalPort;
  export default impl;
}

declare module "@/lib/memory" {
  import type { MemoryPort } from "@/lib/ports";
  const impl: MemoryPort;
  export default impl;
}

declare module "@/lib/events" {
  import type { EventsPort } from "@/lib/ports";
  const impl: EventsPort;
  export default impl;
}

declare module "@/lib/graph" {
  import type { GraphPort } from "@/lib/ports";
  const impl: GraphPort;
  export default impl;
}

declare module "@/lib/voice" {
  import type { VoicePort } from "@/lib/ports";
  const impl: VoicePort;
  export default impl;
}
