import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tells a scroll region whether it is currently clipping content below.
 *
 * A list that ends flush with its container edge reads as "that is all there is", which is
 * exactly the wrong impression when the third vector hit is one pixel below the fold on a
 * 1280x800 projector. The caller pairs this with `bb-fade-b`, and the flag switches the mask
 * off once the region is scrolled to the end so the last row is never left dimmed.
 *
 * `deps` re-measures when content changes, since events arrive after mount.
 */
export function useScrollFade<T extends HTMLElement>(deps: unknown): {
  ref: (node: T | null) => void;
  atEnd: boolean;
} {
  const nodeRef = useRef<T | null>(null);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback((): void => {
    const el = nodeRef.current;
    if (el === null) return;
    // 2px of slack: sub-pixel layout makes an exact comparison flicker on some zoom levels.
    setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight <= 2);
  }, []);

  const ref = useCallback(
    (node: T | null): void => {
      nodeRef.current = node;
      measure();
    },
    [measure],
  );

  useEffect(() => {
    const el = nodeRef.current;
    if (el === null) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });

    // Height changes without a scroll event when the viewport resizes or a card reflows.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure, deps]);

  return { ref, atEnd };
}
