import { createContext, useContext, useEffect, useState } from 'react';
import { createTheme, layoutFor, type LayoutSize, type Theme } from './theme.js';

export const ThemeContext = createContext<Theme>(createTheme());

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export interface TerminalSize {
  columns: number;
  rows: number;
  layout: LayoutSize;
}

function currentSize(): TerminalSize {
  const columns = Math.max(process.stdout.columns || 80, 20);
  const rows = Math.max(process.stdout.rows || 24, 8);
  return { columns, rows, layout: layoutFor(columns) };
}

/** Tracks terminal dimensions so nothing is rendered wider than the window. */
export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(currentSize);

  useEffect(() => {
    const onResize = () => setSize(currentSize());
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  return size;
}

/** Content width inside the standard two-column gutter. */
export function contentWidth(columns: number): number {
  return Math.max(20, columns - 2);
}
