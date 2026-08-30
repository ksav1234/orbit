import os from 'node:os';

/**
 * Orbit's visual language: a small, dense palette and a symbol set that
 * degrades to ASCII on terminals that cannot render box drawing or glyphs.
 */

export interface ThemeColors {
  primary: string;
  accent: string;
  text: string;
  muted: string;
  success: string;
  warning: string;
  danger: string;
  added: string;
  removed: string;
  border: string;
}

export interface ThemeSymbols {
  /** Tool call marker. */
  bullet: string;
  /** Pending / in-progress marker. */
  pending: string;
  success: string;
  failure: string;
  warning: string;
  arrow: string;
  prompt: string;
  branch: string;
  branchLast: string;
  vertical: string;
  horizontal: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  divider: string;
  dot: string;
}

export interface Theme {
  colors: ThemeColors;
  symbols: ThemeSymbols;
  unicode: boolean;
  color: boolean;
  /** Active palette name. */
  name: string;
  /** Per-line colours for the wordmark. */
  gradient: string[];
}

const UNICODE_SYMBOLS: ThemeSymbols = {
  bullet: '●',
  pending: '◌',
  success: '✓',
  failure: '✗',
  warning: '⚠',
  arrow: '→',
  prompt: '›',
  branch: '├─',
  branchLast: '└─',
  vertical: '│',
  horizontal: '─',
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  divider: '─',
  dot: '·',
};

const ASCII_SYMBOLS: ThemeSymbols = {
  bullet: '*',
  pending: 'o',
  success: '+',
  failure: 'x',
  warning: '!',
  arrow: '->',
  prompt: '>',
  branch: '|-',
  branchLast: '`-',
  vertical: '|',
  horizontal: '-',
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  divider: '-',
  dot: '.',
};

const COLOR_THEME: ThemeColors = {
  primary: 'cyan',
  accent: 'magenta',
  text: 'white',
  muted: 'gray',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  added: 'green',
  removed: 'red',
  border: 'gray',
};

const MONO_THEME: ThemeColors = {
  primary: 'white',
  accent: 'white',
  text: 'white',
  muted: 'white',
  success: 'white',
  warning: 'white',
  danger: 'white',
  added: 'white',
  removed: 'white',
  border: 'white',
};

/**
 * Named palettes. Every one keeps added/removed green/red — diff colours are
 * conventions, not decoration, and re-mapping them costs comprehension.
 */
export const THEMES: Record<string, { colors: ThemeColors; gradient: string[] }> = {
  orbit: {
    colors: COLOR_THEME,
    gradient: ['cyanBright', 'cyan', 'blueBright', 'blue', 'magenta', 'magentaBright'],
  },
  mono: {
    colors: MONO_THEME,
    gradient: ['white', 'white', 'gray', 'gray', 'white', 'white'],
  },
  ember: {
    colors: {
      ...COLOR_THEME,
      primary: 'yellow',
      accent: 'red',
      muted: 'gray',
      border: 'gray',
    },
    gradient: ['yellowBright', 'yellow', 'redBright', 'red', 'magenta', 'magentaBright'],
  },
  forest: {
    colors: {
      ...COLOR_THEME,
      primary: 'green',
      accent: 'cyan',
    },
    gradient: ['greenBright', 'green', 'cyanBright', 'cyan', 'blue', 'blueBright'],
  },
  ice: {
    colors: {
      ...COLOR_THEME,
      primary: 'blueBright',
      accent: 'cyanBright',
    },
    gradient: ['white', 'cyanBright', 'cyan', 'blueBright', 'blue', 'blue'],
  },
};

export interface ThemeOptions {
  color?: 'auto' | 'always' | 'never';
  unicode?: 'auto' | 'on' | 'off';
  /** Named palette; unknown names fall back to `orbit`. */
  theme?: string;
}

/**
 * Windows consoles and CI runners frequently lack a UTF-8 code page, so
 * detection is conservative: enable Unicode only when the environment says so.
 */
export function detectUnicodeSupport(): boolean {
  if (process.env.ORBIT_ASCII === '1') return false;
  if (process.platform !== 'win32') {
    const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? '';
    return /UTF-?8/i.test(locale) || locale === '';
  }
  // Windows Terminal, VS Code and modern PowerShell hosts handle Unicode.
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.WSLENV);
}

export function detectColorSupport(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

export function createTheme(options: ThemeOptions = {}): Theme {
  const color =
    options.color === 'always' ? true : options.color === 'never' ? false : detectColorSupport();
  const unicode =
    options.unicode === 'on' ? true : options.unicode === 'off' ? false : detectUnicodeSupport();

  const name = options.theme && THEMES[options.theme] ? options.theme : 'orbit';
  const palette = THEMES[name]!;

  return {
    color,
    unicode,
    name,
    colors: color ? palette.colors : MONO_THEME,
    gradient: color ? palette.gradient : LOGO_GRADIENT_MONO,
    symbols: unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
  };
}

const LOGO_GRADIENT_MONO = ['white', 'white', 'white', 'white', 'white', 'white'];

/** Layout breakpoints. Narrow terminals drop to stacked, single-column output. */
export type LayoutSize = 'narrow' | 'normal' | 'wide';

export function layoutFor(columns: number): LayoutSize {
  if (columns < 60) return 'narrow';
  if (columns < 100) return 'normal';
  return 'wide';
}

// The wordmark and its variants live in logo.ts, which composes them from a
// glyph table so every row is guaranteed to be the same width.
export {
  ORBIT_LOGO,
  ORBIT_LOGO_ASCII,
  ORBIT_LOGO_SMALL,
  ORBIT_AI_LOGO,
  ORBIT_AI_LOGO_ASCII,
  ORBIT_RING,
  TAGLINE,
  BYLINE,
  selectLogo,
  orbitTrack,
  composeWordmark,
} from './logo.js';

/** Time-of-day greeting used in the welcome line. */
export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Best-effort display name for the person at the keyboard. */
export function currentUserName(): string {
  const fromEnv = process.env.ORBIT_USER ?? process.env.USER ?? process.env.USERNAME;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    // userInfo() throws on systems where the uid has no passwd entry.
    return os.userInfo().username;
  } catch {
    return 'developer';
  }
}
