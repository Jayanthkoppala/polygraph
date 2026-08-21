/** Convert a CSS hex triplet into normalized RGB channels for canvas/WebGL. */
export function hexToRgb(hex: string): [number, number, number] {
  let value = hex.replace('#', '').trim();
  if (value.length === 3) value = value.split('').map((character) => character + character).join('');
  const numeric = Number.parseInt(value.slice(0, 6), 16);
  if (Number.isNaN(numeric)) return [0, 0, 0];
  return [((numeric >> 16) & 255) / 255, ((numeric >> 8) & 255) / 255, (numeric & 255) / 255];
}
