import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeContext } from '../src/ui/context.js';
import { createTheme } from '../src/ui/theme.js';
import { Banner } from '../src/ui/components/Header.js';
import { Footer } from '../src/ui/components/Footer.js';
import { PlanView } from '../src/ui/components/Plan.js';
import { DiffView } from '../src/ui/components/DiffView.js';
import { ToolCallView, describeToolArgs } from '../src/ui/components/ToolCall.js';
import { PermissionPrompt } from '../src/ui/components/Permission.js';
import { SelectPrompt, SecretPrompt } from '../src/ui/components/Select.js';
import { ErrorBox } from '../src/ui/components/ErrorBox.js';
import { AssistantMessage, UserMessage } from '../src/ui/components/Message.js';
import { OrbitError } from '../src/util/errors.js';
import type { ToolResult } from '../src/tools/registry.js';

/** Terminal key sequences, built from char codes so no control byte sits in the source. */
const ESCAPE = String.fromCharCode(27);
const DOWN = `${ESCAPE}[B`;

/** Let Ink flush the frame produced by the last keystroke. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const theme = createTheme({ color: 'never', unicode: 'on' });

function draw(node: React.ReactElement): string {
  const { lastFrame } = render(
    <ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>,
  );
  return stripAnsi(lastFrame() ?? '');
}

describe('startup banner', () => {
  it('shows identity, model, provider and workspace', () => {
    const output = draw(
      <Banner
        columns={90}
        layout="wide"
        model="qwen3-coder"
        provider="OpenRouter"
        workspace="/home/dev/projects/orbit"
        session="new"
        workspaceSummary="TypeScript · Ink · npm"
        warnings={[]}
      />,
    );

    expect(output).toContain('AI that works inside your workspace.');
    expect(output).toContain('qwen3-coder');
    expect(output).toContain('OpenRouter');
    expect(output).toContain('projects/orbit');
    expect(output).toContain('TypeScript');
  });

  it('renders warnings when the model lacks a capability', () => {
    const output = draw(
      <Banner
        columns={80}
        layout="normal"
        model="deepseek-chat"
        provider="DeepSeek"
        workspace="/w"
        session="new"
        warnings={['deepseek-chat does not support image input.']}
      />,
    );
    expect(output).toContain('does not support image input');
  });

  it('falls back to a compact wordmark on a narrow terminal', () => {
    const output = draw(
      <Banner columns={40} layout="narrow" model="m" provider="p" workspace="/w" session="new" />,
    );
    expect(output).toContain('ORBIT');
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it('uses the ASCII wordmark when the terminal has no box drawing', () => {
    const asciiTheme = createTheme({ color: 'never', unicode: 'off' });
    const { lastFrame } = render(
      <ThemeContext.Provider value={asciiTheme}>
        <Banner
          columns={90}
          layout="wide"
          model="m"
          provider="p"
          workspace="/w"
          session="new"
          userName="dev"
        />
      </ThemeContext.Provider>,
    );
    const output = stripAnsi(lastFrame() ?? '');

    expect(output).not.toContain('█');
    expect(output).toContain('___');
    expect(output).toContain('AI that works inside your workspace.');
  });

  it('greets the user and reports the model capabilities', () => {
    const output = draw(
      <Banner
        columns={90}
        layout="wide"
        model="gpt-5"
        provider="OpenAI"
        workspace="/home/dev/app"
        session="new"
        userName="ada"
        now={new Date('2026-08-29T09:00:00')}
        version="0.2.0"
        usageSummary="1.2M in / 300k out lifetime"
        modelInfo={{
          model: 'gpt-5',
          provider: 'OpenAI',
          contextWindow: 400_000,
          supportsTools: true,
          supportsVision: true,
        }}
      />,
    );

    expect(output).toContain('Good morning, ada');
    expect(output).toContain('tools');
    expect(output).toContain('vision');
    expect(output).toContain('400k ctx');
    expect(output).toContain('v0.2.0');
    expect(output).toContain('1.2M in / 300k out lifetime');
  });

  it('says plainly when the model has no native tool calling', () => {
    const output = draw(
      <Banner
        columns={90}
        layout="wide"
        model="tiny"
        provider="Local"
        workspace="/w"
        session="new"
        userName="dev"
        modelInfo={{
          model: 'tiny',
          provider: 'Local',
          contextWindow: 8_192,
          supportsTools: false,
          supportsVision: false,
        }}
      />,
    );

    expect(output).toContain('text protocol');
    expect(output).not.toContain('vision');
  });

  it('shows auto mode state and how to change it', () => {
    const off = draw(
      <Banner columns={90} layout="wide" model="m" provider="p" workspace="/w" session="s" userName="dev" />,
    );
    expect(off).toContain('Auto mode');
    expect(off).toContain('ctrl+shift+a to toggle');

    const on = draw(
      <Banner
        columns={90}
        layout="wide"
        model="m"
        provider="p"
        workspace="/w"
        session="s"
        userName="dev"
        autoMode
      />,
    );
    expect(on).toMatch(/Auto mode\s+on/);
  });
});

describe('status bar', () => {
  it('shows context pressure and never overflows the terminal', () => {
    const output = draw(
      <Footer
        model="gpt-5"
        provider="OpenAI"
        workspace="/home/dev/app"
        usedTokens={8200}
        contextWindow={128_000}
        session="2026-08-29-fix"
        columns={70}
        layout="normal"
      />,
    );

    expect(output).toContain('gpt-5');
    expect(output).toContain('8.2k/128k (6%)');
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(70);
    }
  });

  it('marks auto-working mode', () => {
    const output = draw(
      <Footer
        model="m"
        provider="p"
        workspace="/w"
        usedTokens={10}
        contextWindow={100}
        session="s"
        columns={80}
        layout="wide"
        autoMode
      />,
    );
    expect(output).toContain('AUTO');
  });

  it('shows the pressure band once the window fills up', () => {
    const output = draw(
      <Footer
        model="m"
        provider="p"
        workspace="/w"
        usedTokens={95}
        contextWindow={100}
        session="s"
        columns={100}
        layout="wide"
        pressure="critical"
      />,
    );
    expect(output).toContain('95%');
    expect(output).toContain('critical');
  });

  it('replaces the status with a transient hint', () => {
    const output = draw(
      <Footer
        model="m"
        provider="p"
        workspace="/w"
        usedTokens={1}
        contextWindow={100}
        session="s"
        columns={60}
        layout="normal"
        hint="ctrl+c to cancel"
      />,
    );
    expect(output).toContain('ctrl+c to cancel');
  });
});

describe('plan view', () => {
  it('renders the declared steps with their status', () => {
    const output = draw(
      <PlanView
        columns={60}
        steps={[
          { title: 'Inspect project structure', status: 'done' },
          { title: 'Locate the authentication code', status: 'active' },
          { title: 'Run the tests', status: 'pending' },
        ]}
      />,
    );

    expect(output).toContain('Plan');
    expect(output).toContain('1. Inspect project structure');
    expect(output).toContain('2. Locate the authentication code');
    expect(output).toContain('✓');
  });
});

describe('diff view', () => {
  it('renders added and removed lines', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' const token = req.headers.authorization;',
      '-if (!token) return unauthorized();',
      '+if (!token?.trim()) return unauthorized();',
    ].join('\n');

    const output = draw(<DiffView patch={patch} columns={70} />);
    expect(output).toContain('- if (!token) return unauthorized();');
    expect(output).toContain('+ if (!token?.trim()) return unauthorized();');
  });
});

describe('tool call view', () => {
  const result: ToolResult = {
    ok: true,
    content: 'ignored',
    display: {
      kind: 'output',
      summary: 'npm test — succeeded in 3.4s',
      lines: ['✓ auth.test.ts', '✓ session.test.ts'],
      hiddenLines: 342,
      detail: 'full output',
    },
  };

  it('shows the tool, its argument and the real result summary', () => {
    const output = draw(
      <ToolCallView
        name="execute_command"
        args={{ command: 'npm test' }}
        status="ok"
        result={result}
        columns={70}
      />,
    );

    expect(output).toContain('execute_command');
    expect(output).toContain('$ npm test');
    expect(output).toContain('succeeded in 3.4s');
    expect(output).toContain('auth.test.ts');
    expect(output).toContain('342 lines hidden');
  });

  it('shows a denial without pretending the tool ran', () => {
    const output = draw(
      <ToolCallView
        name="delete_file"
        args={{ path: 'src/old.ts' }}
        status="denied"
        deniedReason="The user denied this operation."
        columns={70}
      />,
    );

    expect(output).toContain('delete_file');
    expect(output).toContain('denied this operation');
    expect(output).not.toContain('succeeded');
  });

  it('summarises arguments per tool', () => {
    expect(describeToolArgs('read_file', { path: 'src/a.ts' })).toBe('src/a.ts');
    expect(describeToolArgs('execute_command', { command: 'npm test' })).toBe('$ npm test');
    expect(describeToolArgs('move_file', { source: 'a', destination: 'b' })).toBe('a -> b');
  });
});

describe('permission prompt', () => {
  it('offers a session grant for an ordinary write', () => {
    const output = draw(
      <PermissionPrompt
        columns={76}
        request={{
          category: 'write',
          tool: 'write_file',
          title: 'Overwrite src/auth.ts',
          details: [{ label: 'Size', value: '1.2 KB' }],
          preview: '@@ -1 +1 @@\n-old\n+new',
          previewKind: 'diff',
        }}
        onDecide={() => {}}
      />,
    );

    expect(output).toContain('Permission required');
    expect(output).toContain('Overwrite src/auth.ts');
    expect(output).toContain('[Y] Allow once');
    expect(output).toContain('[A] Allow for session');
    expect(output).toContain('[N] Deny');
  });

  it('withholds the session grant for a destructive operation', () => {
    const output = draw(
      <PermissionPrompt
        columns={76}
        request={{
          category: 'delete',
          tool: 'delete_file',
          title: 'Delete src/old-auth.ts',
          destructive: true,
        }}
        onDecide={() => {}}
      />,
    );

    expect(output).toContain('Destructive operation');
    expect(output).toContain('[Y] Confirm');
    expect(output).toContain('[N] Cancel');
    expect(output).not.toContain('Allow for session');
  });

  it('marks a sensitive file explicitly', () => {
    const output = draw(
      <PermissionPrompt
        columns={76}
        request={{
          category: 'read',
          tool: 'read_file',
          title: 'Share .env with the model?',
          sensitive: true,
          details: [{ label: 'Reason', value: 'This file matches a credentials pattern.' }],
        }}
        onDecide={() => {}}
      />,
    );

    expect(output).toContain('Sensitive file');
    expect(output).toContain('Share .env with the model?');
  });
});

describe('select prompt', () => {
  function mount(options: Array<{ value: string; label: string; current?: boolean; badge?: string }>) {
    const chosen: string[] = [];
    let cancelled = false;
    const instance = render(
      <ThemeContext.Provider value={theme}>
        <SelectPrompt
          title="Model"
          columns={80}
          options={options}
          onSelect={(value) => chosen.push(value)}
          onCancel={() => {
            cancelled = true;
          }}
        />
      </ThemeContext.Provider>,
    );
    return {
      instance,
      chosen,
      wasCancelled: () => cancelled,
      frame: () => stripAnsi(instance.lastFrame() ?? ''),
    };
  }

  const short = [
    { value: 'a', label: 'model-a', current: true, badge: 'current' },
    { value: 'b', label: 'model-b' },
    { value: 'c', label: 'model-c' },
  ];

  it('starts on the current option', async () => {
    const view = mount(short);
    expect(view.frame()).toContain('model-a');
    expect(view.frame()).toContain('current');
    view.instance.stdin.write('\r');
    await flush();
    expect(view.chosen).toEqual(['a']);
    view.instance.unmount();
  });

  it('moves with the arrow keys', async () => {
    const view = mount(short);
    view.instance.stdin.write(DOWN); // down
    view.instance.stdin.write('\r');
    await flush();
    expect(view.chosen).toEqual(['b']);
    view.instance.unmount();
  });

  it('does not run off either end of the list', async () => {
    const view = mount(short);
    for (let i = 0; i < 10; i++) view.instance.stdin.write(DOWN);
    view.instance.stdin.write('\r');
    await flush();
    expect(view.chosen).toEqual(['c']);
    view.instance.unmount();
  });

  it('jumps with a number key on a short list', async () => {
    const view = mount(short);
    view.instance.stdin.write('3');
    await flush();
    expect(view.chosen).toEqual(['c']);
    view.instance.unmount();
  });

  it('cancels on escape', async () => {
    const view = mount(short);
    view.instance.stdin.write(ESCAPE);
    await flush();
    expect(view.wasCancelled()).toBe(true);
    expect(view.chosen).toEqual([]);
    view.instance.unmount();
  });

  it('filters a long list as you type', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      value: `m${i}`,
      label: i === 17 ? 'qwen3-coder' : `filler-model-${i}`,
    }));
    const view = mount(many);

    // A long list scrolls rather than printing 40 rows.
    expect(view.frame()).toContain('more');
    expect(view.frame()).toContain('filter');

    view.instance.stdin.write('qwen');
    await flush();
    expect(view.frame()).toContain('qwen3-coder');
    expect(view.frame()).not.toContain('filler-model-1\n');

    view.instance.stdin.write('\r');
    await flush();
    expect(view.chosen).toEqual(['m17']);
    view.instance.unmount();
  });

  it('says so when a filter matches nothing', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` }));
    const view = mount(many);

    view.instance.stdin.write('zzzzz');
    await flush();
    expect(view.frame()).toContain('nothing matches');

    // Enter on an empty list cancels rather than choosing something arbitrary.
    view.instance.stdin.write('\r');
    await flush();
    expect(view.chosen).toEqual([]);
    expect(view.wasCancelled()).toBe(true);
    view.instance.unmount();
  });
});

describe('secret prompt', () => {
  it('masks the value and never renders it', async () => {
    const submitted: string[] = [];
    const instance = render(
      <ThemeContext.Provider value={theme}>
        <SecretPrompt
          title="API key"
          columns={70}
          onSubmit={(value) => submitted.push(value)}
          onCancel={() => {}}
        />
      </ThemeContext.Provider>,
    );

    instance.stdin.write('sk-secret-value-123');
    await flush();
    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).not.toContain('sk-secret-value-123');
    expect(frame).toContain('•'.repeat(19));

    instance.stdin.write('\r');
    await flush();
    expect(submitted).toEqual(['sk-secret-value-123']);
    instance.unmount();
  });

  it('cancels on escape without submitting', async () => {
    let cancelled = false;
    const instance = render(
      <ThemeContext.Provider value={theme}>
        <SecretPrompt title="API key" columns={70} onSubmit={() => {}} onCancel={() => { cancelled = true; }} />
      </ThemeContext.Provider>,
    );

    instance.stdin.write('partial');
    instance.stdin.write(ESCAPE);
    await flush();
    expect(cancelled).toBe(true);
    instance.unmount();
  });
});

describe('error box', () => {
  it('renders a human-readable failure with recovery hints', () => {
    const output = draw(
      <ErrorBox
        columns={76}
        error={
          new OrbitError('Unable to reach OpenRouter.', {
            kind: 'network',
            detail: 'The request did not complete.',
            hints: ['Check your network connection.', 'Verify the provider base URL.'],
          })
        }
        actions={[
          { key: 'R', label: 'Retry' },
          { key: 'C', label: 'Configure provider' },
        ]}
      />,
    );

    expect(output).toContain('Network Error');
    expect(output).toContain('Unable to reach OpenRouter.');
    expect(output).toContain('Check your network connection.');
    expect(output).toContain('[R] Retry');
    expect(output).not.toContain('ECONNRESET');
  });
});

describe('messages', () => {
  it('renders the user prompt with a marker', () => {
    const output = draw(<UserMessage text="Find the auth bug" columns={60} />);
    expect(output).toContain('› Find the auth bug');
  });

  it('renders assistant markdown: code, lists and emphasis', () => {
    const output = draw(
      <AssistantMessage
        columns={70}
        text={'The issue is in `session.ts`.\n\n- checks before init\n- returns early\n\n```ts\nconst x = 1;\n```'}
      />,
    );

    expect(output).toContain('session.ts');
    expect(output).toContain('checks before init');
    expect(output).toContain('const x = 1;');
    expect(output).not.toContain('```');
  });
});
