import { describe, expect, it } from 'vitest';
import { ContextManager } from '../src/context/manager.js';
import { preservedInstructions, summarizeOlderTurns } from '../src/context/compaction.js';
import type { ContextEntry } from '../src/context/compaction.js';
import { clipToRows } from '../src/util/format.js';

// ── Remembering what the user said ────────────────────────────────────────

let counter = 0;
function entry(role: 'user' | 'assistant', content: string): ContextEntry {
  counter += 1;
  return {
    id: `e${counter}`,
    message: { role, content },
    tokens: Math.ceil(content.length / 4) + 4,
    timestamp: new Date().toISOString(),
  };
}

const STANDING = 'Never touch anything under generated/. It is all machine-written.';

describe('carrying instructions through compaction', () => {
  it('keeps the user own words, newest first, inside the budget', () => {
    const entries = [
      entry('user', 'oldest instruction'),
      entry('assistant', 'fine'),
      entry('user', 'middle instruction'),
      entry('assistant', 'fine'),
      entry('user', 'newest instruction'),
    ];

    const all = preservedInstructions(entries, 1_000);
    expect(all.kept).toEqual(['oldest instruction', 'middle instruction', 'newest instruction']);
    expect(all.droppedCount).toBe(0);
  });

  // A later instruction usually supersedes an earlier one, so when something
  // has to go it should be the oldest.
  it('drops the oldest first when the budget is tight', () => {
    const entries = [
      entry('user', 'A'.repeat(400)),
      entry('user', 'B'.repeat(400)),
      entry('user', 'keep me'),
    ];

    const tight = preservedInstructions(entries, 120);
    expect(tight.kept).toContain('keep me');
    expect(tight.kept.length).toBeLessThan(3);
    expect(tight.droppedCount).toBeGreaterThan(0);
  });

  it('ignores assistant turns and earlier summaries', () => {
    const summary: ContextEntry = { ...entry('user', 'a previous summary'), synthetic: true };
    const entries = [summary, entry('assistant', 'not an instruction'), entry('user', 'real one')];

    expect(preservedInstructions(entries, 1_000).kept).toEqual(['real one']);
  });

  // Orbit's own mid-conversation notes travel on the user role because that is
  // the only channel available. Quoting a stale verification failure back as a
  // standing instruction would be both wasteful and misleading.
  it('does not mistake its own notes for things the user said', () => {
    const context = new ContextManager({ contextWindow: 10_000 });
    context.addUserMessage('Never touch generated/');
    context.addSystemNote('Your changes did not pass verification (attempt 1 of 2).');
    context.addUserMessage('Also use tabs');

    const kept = preservedInstructions([...context.entries()], 1_000).kept;

    expect(kept).toEqual(['Never touch generated/', 'Also use tabs']);
    expect(kept.join(' ')).not.toContain('[Orbit]');
  });

  it('clips an enormous paste rather than quoting all of it', () => {
    const kept = preservedInstructions([entry('user', 'x'.repeat(10_000))], 4_000).kept;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.length).toBeLessThan(2_100);
    expect(kept[0]!.endsWith('…')).toBe(true);
  });

  it('can be switched off', () => {
    expect(preservedInstructions([entry('user', 'anything')], 0).kept).toEqual([]);
  });

  // The reported failure: after a long session the agent breaks a rule it was
  // given at the start, because the summariser paraphrased it away.
  it('survives summarisation word-for-word', async () => {
    const entries = [entry('user', STANDING)];
    for (let i = 0; i < 20; i++) {
      entries.push(entry(i % 2 === 0 ? 'assistant' : 'user', `routine chatter ${i}`));
    }

    const result = await summarizeOlderTurns(entries, {
      keepRecent: 4,
      // A realistic summariser: it records what happened, not what it was told.
      summarizer: async () => 'We renamed several modules and fixed the build.',
    });

    const text = String(result.entries[0]?.message.content);
    expect(text).toContain('We renamed several modules');
    // The instruction itself, not a paraphrase of it.
    expect(text).toContain(STANDING);
    expect(text).toMatch(/still in force/i);
  });

  it('loses the instruction when preservation is disabled', async () => {
    const entries = [entry('user', STANDING)];
    for (let i = 0; i < 20; i++) {
      entries.push(entry(i % 2 === 0 ? 'assistant' : 'user', `routine chatter ${i}`));
    }

    const result = await summarizeOlderTurns(entries, {
      keepRecent: 4,
      instructionTokens: 0,
      summarizer: async () => 'We renamed several modules.',
    });

    // Documents exactly what the old behaviour was, and why it looked like
    // forgetting.
    expect(String(result.entries[0]?.message.content)).not.toContain(STANDING);
  });

  it('keeps the instruction through a real compaction cycle', async () => {
    const context = new ContextManager({
      contextWindow: 4_000,
      compactThreshold: 0.5,
      instructionTokens: 1_000,
    });

    context.addUserMessage(STANDING);
    for (let i = 0; i < 40; i++) {
      context.addUserMessage(`please do task ${i}`);
      context.addAssistantMessage(`done with task ${i}. `.repeat(20), []);
    }

    await context.compact({ tools: [], force: true, summarizer: async () => 'Lots of tasks.' });

    const surviving = context
      .messages()
      .map((message) => String(message.content))
      .join('\n');
    expect(surviving).toContain(STANDING);
  });
});

// ── Not repainting the whole screen ───────────────────────────────────────

describe('keeping the live region inside the window', () => {
  it('shows the tail and counts what scrolled past', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const clipped = clipToRows(text, 10, 80);

    expect(clipped.text.split('\n')).toHaveLength(10);
    expect(clipped.text.startsWith('line 40')).toBe(true);
    expect(clipped.hiddenLines).toBe(40);
  });

  it('leaves short text alone', () => {
    const text = 'one\ntwo\nthree';
    expect(clipToRows(text, 30, 80)).toEqual({ text, hiddenLines: 0 });
  });

  // A wrapped line occupies several rows of the window, so counting lines
  // rather than rows would still overflow and still flicker.
  it('counts a wrapped line as the rows it really occupies', () => {
    const wide = 'x'.repeat(240); // three rows at 80 columns
    const text = ['a', 'b', 'c', wide, 'tail'].join('\n');

    const clipped = clipToRows(text, 5, 80);

    // 'c' (1) + wide (3) + tail (1) is exactly 5 rows; 'b' would make it 6.
    expect(clipped.text.split('\n')).toEqual(['c', wide, 'tail']);
    expect(clipped.hiddenLines).toBe(2);

    // Counting lines instead of rows would have kept five lines here, which
    // is eight rows — taller than the window, and back to flickering.
    const naive = text.split('\n').slice(-5);
    const naiveRows = naive.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 80)), 0);
    expect(naiveRows).toBeGreaterThan(5);
  });

  it('still shows something when one line is taller than the budget', () => {
    const huge = 'y'.repeat(10_000);
    const clipped = clipToRows(`first\n${huge}`, 2, 80);
    expect(clipped.text).toBe(huge);
    expect(clipped.hiddenLines).toBe(1);
  });

  it('handles the degenerate cases without throwing', () => {
    expect(clipToRows('', 10, 80).text).toBe('');
    expect(clipToRows('anything', 0, 80)).toEqual({ text: '', hiddenLines: 0 });
    expect(() => clipToRows('a\nb', 5, 0)).not.toThrow();
  });

  it('never returns more rows than it was given', () => {
    const text = Array.from({ length: 200 }, (_, i) => 'z'.repeat(i * 3)).join('\n');
    for (const budget of [1, 5, 20, 60]) {
      const clipped = clipToRows(text, budget, 80);
      const rows = clipped.text
        .split('\n')
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 80)), 0);
      // The single-line exception can exceed it; everything else must not.
      if (clipped.text.includes('\n')) expect(rows).toBeLessThanOrEqual(budget);
    }
  });
});
