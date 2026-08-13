import { SPOKEN_WORD_CAP } from "@/lib/contracts";

const SENTENCE_END = /[.!?]$/;

export function toSpoken(text: string, cap = SPOKEN_WORD_CAP): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= cap) return words.join(" ");

  const capped = words.slice(0, cap);
  for (let i = capped.length - 1; i >= 0; i -= 1) {
    if (SENTENCE_END.test(capped[i])) {
      return capped.slice(0, i + 1).join(" ");
    }
  }
  const last = capped[capped.length - 1];
  capped[capped.length - 1] = SENTENCE_END.test(last) ? last : `${last}.`;
  return capped.join(" ");
}
