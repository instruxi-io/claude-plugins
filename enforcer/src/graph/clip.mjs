export const OUTPUT_CLIP = 4000;

/** Clip to n characters keeping both ends (the verdict line is last). */
export function clipOutput(s, n = OUTPUT_CLIP, headShare = 0.3) {
  if (s.length <= n) return s;
  const head = Math.floor(n * headShare);
  let marker = '';
  for (let i = 0; i < 3; i++) {
    const tail = n - head - marker.length;
    marker = `\n...[${s.length - head - tail} characters elided]...\n`;
  }
  const tail = n - head - marker.length;
  if (tail <= 0) return s.slice(0, n);
  return s.slice(0, head) + marker + s.slice(s.length - tail);
}
