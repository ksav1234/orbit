import { z } from 'zod';
import { defineTool, toolError, toolOk, type Tool, type ToolContext } from './registry.js';
import { OrbitError, isCancellation, toFriendlyError } from '../util/errors.js';
import { withTimeoutSignal } from '../util/async.js';
import { clampChars, oneLine, pluralize, truncateWidth } from '../util/format.js';
import { redact } from '../util/redact.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('tools:web');

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilyResult[];
  response_time?: number;
}

interface TavilyExtractResponse {
  results?: Array<{ url?: string; raw_content?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
}

/**
 * Guard rails shared by both web tools: the feature has to be enabled, a key
 * has to exist, and the request has to be cancellable.
 */
function requireWeb(context: ToolContext):
  | { ok: true; apiKey: string; config: NonNullable<ToolContext['web']>['config'] }
  | { ok: false; message: string } {
  const web = context.web;
  if (!web || !web.config.enabled) {
    return {
      ok: false,
      message:
        'Web access is disabled. The user can enable it in `orbit config` → Web access, after adding a Tavily API key.',
    };
  }
  if (!web.apiKey) {
    return {
      ok: false,
      message:
        'No Tavily API key is configured, so Orbit cannot search the web. The user can add one with `orbit web key` or by setting TAVILY_API_KEY.',
    };
  }
  return { ok: true, apiKey: web.apiKey, config: web.config };
}

async function tavilyRequest<T>(
  path: string,
  body: Record<string, unknown>,
  options: { apiKey: string; baseURL: string; timeoutMs: number; signal: AbortSignal },
): Promise<T> {
  const timeout = withTimeoutSignal(options.timeoutMs, options.signal);
  try {
    const response = await fetch(`${options.baseURL.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        'user-agent': 'orbit-cli',
      },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });

    if (!response.ok) {
      const detail = redact((await response.text().catch(() => '')).slice(0, 500));
      if (response.status === 401 || response.status === 403) {
        throw new OrbitError('Tavily rejected the API key.', {
          kind: 'auth',
          detail,
          hints: ['Check the key with: orbit web key', 'Keys look like tvly-...'],
        });
      }
      if (response.status === 429) {
        throw new OrbitError('Tavily rate limit reached.', {
          kind: 'rate-limit',
          detail,
          retryable: true,
        });
      }
      throw new OrbitError(`Tavily request failed (HTTP ${response.status}).`, {
        kind: 'provider',
        detail,
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    if (timeout.timedOut()) {
      throw new OrbitError(`Tavily did not respond within ${Math.round(options.timeoutMs / 1000)}s.`, {
        kind: 'network',
        retryable: true,
      });
    }
    if (isCancellation(error)) throw error;
    throw toFriendlyError(error, { provider: 'Tavily' });
  } finally {
    timeout.dispose();
  }
}

// ── web_search ─────────────────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(2).describe('What to search the web for.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('How many results to return. Defaults to the configured value.'),
  depth: z
    .enum(['basic', 'advanced'])
    .optional()
    .describe('advanced costs more and digs deeper; use it when basic came back thin.'),
  include_domains: z.array(z.string()).default([]).describe('Restrict results to these domains.'),
  exclude_domains: z.array(z.string()).default([]).describe('Never return results from these domains.'),
});

export const webSearchTool: Tool = defineTool({
  name: 'web_search',
  description:
    'Search the web for current information: documentation, error messages, release notes, APIs. Returns titles, URLs and extracts. Use web_fetch afterwards to read a specific page in full. Requires network permission.',
  parameters: searchSchema,
  permission: 'network',
  readOnly: true,
  async authorize(args, context) {
    return {
      category: 'network',
      tool: 'web_search',
      title: 'Search the web',
      details: [
        { label: 'Query', value: oneLine(args.query, 60) },
        { label: 'Service', value: 'Tavily' },
        { label: 'Sent', value: 'Only the query text leaves your machine.' },
      ],
      target: 'web_search',
    };
  },
  async execute(args, context) {
    const gate = requireWeb(context);
    if (!gate.ok) return toolError(gate.message);

    context.progress(`Searching: ${oneLine(args.query, 50)}`);

    let payload: TavilySearchResponse;
    try {
      payload = await tavilyRequest<TavilySearchResponse>(
        '/search',
        {
          query: args.query,
          search_depth: args.depth ?? gate.config.searchDepth,
          max_results: args.max_results ?? gate.config.maxResults,
          include_answer: gate.config.includeAnswer,
          include_raw_content: false,
          ...(args.include_domains.length ? { include_domains: args.include_domains } : {}),
          ...(args.exclude_domains.length ? { exclude_domains: args.exclude_domains } : {}),
        },
        {
          apiKey: gate.apiKey,
          baseURL: gate.config.baseURL,
          timeoutMs: gate.config.timeoutMs,
          signal: context.signal,
        },
      );
    } catch (error) {
      const friendly = toFriendlyError(error, { provider: 'Tavily' });
      log.warn('web search failed', { message: friendly.message });
      return toolError(friendly.detail ? `${friendly.message} ${friendly.detail}` : friendly.message);
    }

    const results = payload.results ?? [];
    if (results.length === 0) {
      return toolOk(`No web results for "${args.query}".`, {
        kind: 'matches',
        summary: `no results for "${truncateWidth(args.query, 40)}"`,
      });
    }

    const rendered = results
      .map((result, index) => {
        const parts = [
          `${index + 1}. ${result.title ?? 'Untitled'}`,
          `   ${result.url ?? ''}`,
          result.published_date ? `   published: ${result.published_date}` : '',
          result.content ? `   ${clampChars(result.content.trim(), 1200).text}` : '',
        ];
        return parts.filter(Boolean).join('\n');
      })
      .join('\n\n');

    const answer = payload.answer?.trim();
    const content = [
      `Web search: ${args.query}`,
      answer ? `\nProvider summary (verify before relying on it):\n${answer}` : '',
      `\n${rendered}`,
      '\nThese are search results, not verified facts. Open a page with web_fetch before quoting it as authoritative.',
    ]
      .filter(Boolean)
      .join('\n');

    return toolOk(
      content,
      {
        kind: 'matches',
        summary: `${pluralize(results.length, 'result')} for "${truncateWidth(args.query, 36)}"`,
        lines: results
          .slice(0, 8)
          .map((result) => truncateWidth(`${result.title ?? 'Untitled'} — ${result.url ?? ''}`, 100)),
        detail: rendered,
      },
      { metadata: { results: results.length, hasAnswer: Boolean(answer) } },
    );
  },
});

// ── web_fetch ──────────────────────────────────────────────────────────────

const fetchSchema = z.object({
  urls: z
    .array(z.string().url())
    .min(1)
    .max(5)
    .describe('Page URLs to read. Prefer one or two at a time.'),
  depth: z
    .enum(['basic', 'advanced'])
    .optional()
    .describe('advanced handles JavaScript-heavy pages; it is slower.'),
});

export const webFetchTool: Tool = defineTool({
  name: 'web_fetch',
  description:
    'Read the text content of specific web pages. Use after web_search to read a promising result in full, or when the user gives you a URL. Requires network permission.',
  parameters: fetchSchema,
  permission: 'network',
  readOnly: true,
  async authorize(args) {
    return {
      category: 'network',
      tool: 'web_fetch',
      title: `Fetch ${pluralize(args.urls.length, 'page')}`,
      details: args.urls.slice(0, 4).map((url, index) => ({
        label: `URL ${index + 1}`,
        value: truncateWidth(url, 60),
      })),
      target: 'web_fetch',
    };
  },
  async execute(args, context) {
    const gate = requireWeb(context);
    if (!gate.ok) return toolError(gate.message);

    context.progress(`Fetching ${pluralize(args.urls.length, 'page')}`);

    let payload: TavilyExtractResponse;
    try {
      payload = await tavilyRequest<TavilyExtractResponse>(
        '/extract',
        {
          urls: args.urls,
          extract_depth: args.depth ?? gate.config.searchDepth,
        },
        {
          apiKey: gate.apiKey,
          baseURL: gate.config.baseURL,
          timeoutMs: gate.config.timeoutMs,
          signal: context.signal,
        },
      );
    } catch (error) {
      const friendly = toFriendlyError(error, { provider: 'Tavily' });
      return toolError(friendly.detail ? `${friendly.message} ${friendly.detail}` : friendly.message);
    }

    const results = payload.results ?? [];
    const failed = payload.failed_results ?? [];

    if (results.length === 0) {
      const reasons = failed
        .map((entry) => `${entry.url ?? 'unknown'}: ${entry.error ?? 'could not be extracted'}`)
        .join('; ');
      return toolError(`No page content could be extracted. ${reasons}`.trim());
    }

    // Split the budget across pages so one long article cannot crowd out the rest.
    const perPage = Math.max(2_000, Math.floor(gate.config.maxContentChars / results.length));

    const sections = results.map((result) => {
      const body = clampChars((result.raw_content ?? '').trim(), perPage);
      return `--- ${result.url ?? 'unknown url'} ---\n${body.text || '(no text extracted)'}`;
    });

    const failureNote = failed.length
      ? `\n\nCould not extract ${pluralize(failed.length, 'page')}: ${failed
          .map((entry) => entry.url ?? 'unknown')
          .join(', ')}`
      : '';

    return toolOk(
      `${sections.join('\n\n')}${failureNote}`,
      {
        kind: 'text',
        summary: `${pluralize(results.length, 'page')} fetched${failed.length ? `, ${failed.length} failed` : ''}`,
        lines: results.map((result) => truncateWidth(result.url ?? '', 100)),
        detail: sections.join('\n\n'),
      },
      { metadata: { fetched: results.length, failed: failed.length } },
    );
  },
});

export const webTools: Tool[] = [webSearchTool, webFetchTool];
