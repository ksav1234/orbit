import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeContext } from '../src/ui/context.js';
import { createTheme } from '../src/ui/theme.js';
import { AnimatedBanner } from '../src/ui/components/AnimatedBanner.js';
import {
  BYLINE,
  ORBIT_AI_LOGO,
  ORBIT_AI_LOGO_ASCII,
  ORBIT_LOGO_SMALL,
  composeWordmark,
  orbitTrack,
  selectLogo,
} from '../src/ui/logo.js';

const theme = createTheme({ color: 'never', unicode: 'on' });
const asciiTheme = createTheme({ color: 'never', unicode: 'off' });

const flush = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `predicate` holds. The banner animates on real timers, so a fixed
 * sleep is a bet that the machine was not busy — which it sometimes loses when
 * the whole suite runs in parallel. Polling keeps the tests fast when idle and
 * correct when the box is loaded.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the banner');
    await flush(10);
  }
}

describe('wordmark composition', () => {
  it('produces a rectangle, so column effects cannot tear it', () => {
    for (const logo of [ORBIT_AI_LOGO, composeWordmark('ORBIT'), composeWordmark('AI')]) {
      const widths = new Set(logo.map((line) => line.length));
      expect(widths.size).toBe(1);
      expect(logo).toHaveLength(6);
    }
  });

  it('spells ORBIT AI', () => {
    // The 'A' crossbar only appears in the third row of an A glyph.
    expect(ORBIT_AI_LOGO[2]).toContain('███████║');
    expect(ORBIT_AI_LOGO[0]!.length).toBeGreaterThan(composeWordmark('ORBIT')[0]!.length);
  });

  it('ignores characters it has no glyph for', () => {
    expect(composeWordmark('OR@BIT')).toEqual(composeWordmark('ORBIT'));
  });
});

describe('logo selection', () => {
  it('uses the full mark on a wide unicode terminal', () => {
    const choice = selectLogo({ columns: 100, unicode: true, narrow: false });
    expect(choice.lines).toEqual(ORBIT_AI_LOGO);
    expect(choice.block).toBe(true);
  });

  it('drops to ORBIT when ORBIT AI will not fit', () => {
    const choice = selectLogo({ columns: 45, unicode: true, narrow: false });
    expect(choice.block).toBe(true);
    expect(choice.lines[0]!.length).toBeLessThan(ORBIT_AI_LOGO[0]!.length);
    expect(choice.lines[0]!.length).toBeLessThanOrEqual(45);
  });

  it('uses ASCII art without box-drawing support', () => {
    const choice = selectLogo({ columns: 100, unicode: false, narrow: false });
    expect(choice.lines).toEqual(ORBIT_AI_LOGO_ASCII);
    expect(choice.lines.join('')).not.toContain('█');
  });

  it('falls back to a text wordmark on a narrow terminal', () => {
    expect(selectLogo({ columns: 40, unicode: true, narrow: true }).lines).toEqual(ORBIT_LOGO_SMALL);
    expect(selectLogo({ columns: 20, unicode: true, narrow: false }).lines).toEqual(ORBIT_LOGO_SMALL);
  });

  it('never returns a line wider than the terminal', () => {
    for (const columns of [24, 40, 56, 80, 120]) {
      for (const unicode of [true, false]) {
        const choice = selectLogo({ columns, unicode, narrow: columns < 60 });
        for (const line of choice.lines) {
          expect(line.length).toBeLessThanOrEqual(columns);
        }
      }
    }
  });
});

describe('orbit track', () => {
  it('moves the satellite as the phase advances', () => {
    const positionAt = (phase: number): number =>
      orbitTrack({ width: 30, phase, unicode: true }).findIndex((cell) => cell.char === '●');

    const start = positionAt(0);
    const quarter = positionAt(Math.PI / 2);
    const half = positionAt(Math.PI);

    expect(start).not.toBe(quarter);
    expect(quarter).not.toBe(half);
    // cos() sweeps end to end, so it reverses direction rather than wrapping.
    expect(start).toBeGreaterThan(half);
  });

  it('always draws exactly one satellite', () => {
    for (let phase = 0; phase < 6.5; phase += 0.3) {
      const heads = orbitTrack({ width: 24, phase, unicode: true }).filter(
        (cell) => cell.char === '●',
      );
      expect(heads.length).toBeLessThanOrEqual(2);
      expect(heads.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('uses ASCII characters when Unicode is unavailable', () => {
    const chars = orbitTrack({ width: 20, phase: 1, unicode: false })
      .map((cell) => cell.char)
      .join('');
    expect(chars).not.toMatch(/[·∘○●]/);
    expect(chars).toContain('@');
  });
});

describe('animated banner', () => {
  function mount(overrides: Partial<React.ComponentProps<typeof AnimatedBanner>> = {}) {
    let completed = 0;
    const instance = render(
      <ThemeContext.Provider value={overrides.columns === 0 ? asciiTheme : theme}>
        <AnimatedBanner
          columns={90}
          layout="wide"
          userName="dev"
          frameMs={4}
          onComplete={() => {
            completed += 1;
          }}
          {...overrides}
        />
      </ThemeContext.Provider>,
    );
    return {
      instance,
      completions: () => completed,
      frame: () => stripAnsi(instance.lastFrame() ?? ''),
    };
  }

  it('reveals the wordmark progressively', async () => {
    // A slow frame rate keeps the assertion about the reveal rather than about
    // how many timer ticks the test runner managed to squeeze in.
    const view = mount({ frameMs: 40 });

    // The very first frame, before any tick, has nothing drawn yet.
    expect(stripAnsi(view.instance.frames[0] ?? '')).not.toContain('█');

    await flush(80);
    const partial = view.frame();
    expect(partial).toContain('█');

    const widthOf = (frame: string): number =>
      Math.max(
        0,
        ...frame
          .split('\n')
          .filter((line) => line.includes('█'))
          .map((line) => line.trimEnd().length),
      );

    await waitFor(() => view.completions() > 0);
    const complete = view.frame();

    expect(widthOf(partial)).toBeLessThan(widthOf(complete));
    expect(complete).toContain('╚═════╝');

    view.instance.unmount();
  });

  it('shows the tagline and byline, then completes exactly once', async () => {
    const view = mount();
    await waitFor(() => view.completions() > 0);

    expect(view.frame()).toContain('AI that works inside your workspace.');
    expect(view.frame()).toContain(BYLINE);
    expect(view.frame()).toContain('dev');
    expect(view.completions()).toBe(1);

    view.instance.unmount();
  });

  it('can be skipped with a keypress', async () => {
    const view = mount({ frameMs: 500 });
    await flush(20);

    expect(view.completions()).toBe(0);
    view.instance.stdin.write(' ');
    await waitFor(() => view.completions() > 0);

    expect(view.completions()).toBe(1);
    view.instance.unmount();
  });

  it('never completes more than once', async () => {
    const view = mount({ frameMs: 500 });
    await flush(10);

    view.instance.stdin.write(' ');
    view.instance.stdin.write(' ');
    view.instance.stdin.write('x');
    await waitFor(() => view.completions() > 0);

    // Extra keystrokes after the first must not fire onComplete again.
    await flush(30);
    expect(view.completions()).toBe(1);
    view.instance.unmount();
  });

  it('stays inside the terminal width', async () => {
    const view = mount({ columns: 48 });
    await waitFor(() => view.completions() > 0);

    for (const line of view.frame().split('\n')) {
      expect(line.length).toBeLessThanOrEqual(48);
    }
    view.instance.unmount();
  });
});
