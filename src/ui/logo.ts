/**
 * The Orbit wordmark.
 *
 * Letters are composed from a glyph table rather than written out as finished
 * lines: it guarantees every row is the same width, which is what keeps the
 * reveal animation from tearing.
 */

type Glyph = readonly string[];

const HEIGHT = 6;

const GLYPHS: Record<string, Glyph> = {
  O: [
    ' ██████╗ ',
    '██╔═══██╗',
    '██║   ██║',
    '██║   ██║',
    '╚██████╔╝',
    ' ╚═════╝ ',
  ],
  R: [
    '██████╗ ',
    '██╔══██╗',
    '██████╔╝',
    '██╔══██╗',
    '██║  ██║',
    '╚═╝  ╚═╝',
  ],
  B: [
    '██████╗ ',
    '██╔══██╗',
    '██████╔╝',
    '██╔══██╗',
    '██████╔╝',
    '╚═════╝ ',
  ],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  T: [
    '████████╗',
    '╚══██╔══╝',
    '   ██║   ',
    '   ██║   ',
    '   ██║   ',
    '   ╚═╝   ',
  ],
  A: [
    ' █████╗ ',
    '██╔══██╗',
    '███████║',
    '██╔══██║',
    '██║  ██║',
    '╚═╝  ╚═╝',
  ],
  ' ': ['    ', '    ', '    ', '    ', '    ', '    '],
};

/** Join glyphs side by side into a block of equal-width lines. */
export function composeWordmark(text: string, gap = 0): string[] {
  const rows = Array.from({ length: HEIGHT }, () => '');
  const spacer = ' '.repeat(gap);

  for (const [index, character] of [...text.toUpperCase()].entries()) {
    const glyph = GLYPHS[character];
    if (!glyph) continue;
    for (let row = 0; row < HEIGHT; row++) {
      rows[row] += (index > 0 ? spacer : '') + glyph[row];
    }
  }

  // Pad to a rectangle so column-based effects can index any row safely.
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => row.padEnd(width));
}

/** Full "ORBIT AI" block art. */
export const ORBIT_AI_LOGO = composeWordmark('ORBIT AI');

/** Just "ORBIT", for terminals that cannot fit the full mark. */
export const ORBIT_LOGO = composeWordmark('ORBIT');

/** Pure-ASCII fallback for terminals without box-drawing glyphs. */
export const ORBIT_AI_LOGO_ASCII = [
  '  ___  ___  ___ ___ _____     _   ___ ',
  ' / _ \\| _ \\| _ )_ _|_   _|   /_\\ |_ _|',
  '| (_) |   /| _ \\| |  | |    / _ \\ | | ',
  ' \\___/|_|_\\|___/___| |_|   /_/ \\_\\___|',
];

export const ORBIT_LOGO_ASCII = [
  '   ___  ___  ___ ___ _____ ',
  '  / _ \\| _ \\| _ )_ _|_   _|',
  ' | (_) |   /| _ \\| |  | |  ',
  '  \\___/|_|_\\|___/___| |_|  ',
];

/** Compact wordmark for narrow terminals. */
export const ORBIT_LOGO_SMALL = ['ORBIT AI'];

export const TAGLINE = 'AI that works inside your workspace.';

/** Author credit shown under the wordmark. */
export const BYLINE = 'by -Ksav_Ydv';

export const LOGO_WIDTH = ORBIT_AI_LOGO[0]?.length ?? 0;

export interface LogoChoice {
  lines: string[];
  /** Whether this variant is the full block art, which the animation needs. */
  block: boolean;
}

/** Pick the largest wordmark that fits the terminal and its glyph support. */
export function selectLogo(options: {
  columns: number;
  unicode: boolean;
  narrow: boolean;
}): LogoChoice {
  const { columns, unicode, narrow } = options;

  if (narrow || columns < 34) return { lines: ORBIT_LOGO_SMALL, block: false };
  if (!unicode) {
    return columns >= ORBIT_AI_LOGO_ASCII[0]!.length + 2
      ? { lines: ORBIT_AI_LOGO_ASCII, block: false }
      : { lines: ORBIT_LOGO_ASCII, block: false };
  }
  if (columns >= LOGO_WIDTH + 2) return { lines: ORBIT_AI_LOGO, block: true };
  if (columns >= (ORBIT_LOGO[0]?.length ?? 0) + 2) return { lines: ORBIT_LOGO, block: true };
  return { lines: ORBIT_LOGO_ASCII, block: false };
}

/**
 * A satellite tracing an elliptical path, rendered as a single line of
 * characters. `phase` advances the satellite; the trail fades behind it.
 */
export function orbitTrack(options: {
  width: number;
  phase: number;
  unicode: boolean;
}): Array<{ char: string; intensity: number }> {
  const { width, phase, unicode } = options;
  const track = unicode
    ? { empty: ' ', dot: '·', near: '∘', body: '○', head: '●' }
    : { empty: ' ', dot: '.', near: 'o', body: 'O', head: '@' };

  const slots = Math.max(8, width);
  // cos() spends more time near the extremes, which reads as an object
  // swinging around the far side of an ellipse rather than sliding linearly.
  const position = ((Math.cos(phase) + 1) / 2) * (slots - 1);

  return Array.from({ length: slots }, (_, index) => {
    const distance = Math.abs(index - position);
    if (distance < 0.6) return { char: track.head, intensity: 1 };
    if (distance < 1.6) return { char: track.body, intensity: 0.75 };
    if (distance < 2.8) return { char: track.near, intensity: 0.5 };
    // A sparse dotted path so the track is visible without being busy.
    return index % 3 === 0
      ? { char: track.dot, intensity: 0.2 }
      : { char: track.empty, intensity: 0 };
  });
}

/** Static ring used when animation is off. */
export const ORBIT_RING = {
  unicode: '·  ∘  ○  ●  ○  ∘  ·',
  ascii: '.  o  O  (*)  O  o  .',
};
