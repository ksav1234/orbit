import readline from 'node:readline';
import { Writable } from 'node:stream';
import { Chalk } from 'chalk';
import { detectColorSupport } from '../ui/theme.js';

const paint = new Chalk({ level: detectColorSupport() ? 1 : 0 });

export const ui = {
  title: (text: string) => paint.cyan.bold(text),
  label: (text: string) => paint.gray(text),
  value: (text: string) => paint.white(text),
  ok: (text: string) => paint.green(text),
  warn: (text: string) => paint.yellow(text),
  error: (text: string) => paint.red(text),
  dim: (text: string) => paint.gray(text),
  accent: (text: string) => paint.magenta(text),
};

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

function createInterface(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface();
  const suffix = defaultValue ? ui.dim(` (${defaultValue})`) : '';
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question}${suffix}: `, resolve);
    });
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

/**
 * Read a secret without echoing it. The key is never printed, logged, or
 * written to the shell history by Orbit.
 */
export async function askSecret(question: string): Promise<string> {
  let muted = false;
  const mutedOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question}: `, (value) => {
        muted = false;
        process.stdout.write('\n');
        resolve(value);
      });
      muted = true;
    });
    return answer.trim();
  } finally {
    rl.close();
  }
}

export interface Choice<T> {
  value: T;
  label: string;
  description?: string;
}

export async function select<T>(
  question: string,
  choices: Array<Choice<T>>,
  defaultIndex = 0,
): Promise<T> {
  print();
  print(ui.title(question));
  print();
  choices.forEach((choice, index) => {
    const marker = index === defaultIndex ? ui.accent('●') : ' ';
    const description = choice.description ? ui.dim(`  ${choice.description}`) : '';
    print(`  ${marker} ${String(index + 1).padStart(2)}. ${ui.value(choice.label)}${description}`);
  });
  print();

  for (;;) {
    const answer = await ask('Choose', String(defaultIndex + 1));
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      return choices[index]!.value;
    }
    const byLabel = choices.find(
      (choice) => choice.label.toLowerCase() === answer.toLowerCase().trim(),
    );
    if (byLabel) return byLabel.value;
    printError(ui.warn(`Enter a number between 1 and ${choices.length}.`));
  }
}

export async function confirm(question: string, defaultValue = true): Promise<boolean> {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} [${suffix}]`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer.startsWith('y');
}

export function table(rows: Array<[string, string]>, indent = '  '): void {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    print(`${indent}${ui.label(label.padEnd(width))}  ${ui.value(value)}`);
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
