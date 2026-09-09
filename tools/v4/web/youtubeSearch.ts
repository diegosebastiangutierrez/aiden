/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/web/youtubeSearch.ts — `youtube_search` (Phase 23.4a).
 *
 * Bug X fix (Phase 22 Group D smoke): the model was inventing 11-char
 * YouTube IDs whenever `web_search` returned snippet text without an
 * embedded `/watch?v=` URL. `open_url` happily opened whatever the
 * model produced, sending users to "Video unavailable" pages.
 *
 * This tool removes the failure mode by structure: it hits the public
 * YouTube results page, parses real `/watch?v=ID` URLs out of the
 * response, and returns them. Skills consume the URL list and pass
 * one through to `open_url`. The model never composes an ID — the
 * URL is always one the network response delivered.
 *
 * Approval: read-only network fetch to a single public domain. Same
 * approval profile as `web_search`.
 *
 * No third-party dep. Plain `fetch` + regex on `ytInitialData` and
 * raw HTML. YouTube changes its results page often enough that we
 * keep two extraction paths and accept whichever lands first:
 *   1. ytInitialData JSON (preferred — gives title + channel)
 *   2. raw `/watch?v=ID` regex (fallback — gives URL only)
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const RESULTS_URL = 'https://www.youtube.com/results';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * One result item. `title` and `channel` are best-effort — they fail
 * to populate when YouTube ships a results-page variant our parser
 * doesn't recognise. `videoId` and `url` are guaranteed; if neither
 * extraction path produced any IDs the tool returns success:false.
 */
export interface YoutubeSearchResult {
  videoId: string;
  url: string;
  title?: string;
  channel?: string;
  durationText?: string;
}

/**
 * Build the request URL. Encodes the query, sticks to the
 * `search_query` parameter YouTube has used since forever, and
 * pins to standard results (not Shorts, channels, playlists).
 */
function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({ search_query: query });
  return `${RESULTS_URL}?${params.toString()}`;
}

/**
 * Headers that get YouTube to serve the standard desktop results
 * page without redirecting to consent flows or returning the
 * mobile-lite variant. CONSENT=YES+1 satisfies the EU cookie wall;
 * the desktop User-Agent string matches a recent Chrome.
 */
function browserHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Cookie: 'CONSENT=YES+1; SOCS=CAI',
  };
}

/**
 * Pull `var ytInitialData = {…};` out of the HTML. YouTube inlines
 * a large JSON blob containing the rendered results; parsing it
 * gives us titles + channels in addition to IDs. Tolerates the two
 * common assignment shapes (`var ytInitialData = ` and
 * `window["ytInitialData"] = `) and falls back to null on parse
 * failure so callers can switch to the regex path.
 */
function extractInitialData(html: string): unknown | null {
  const patterns = [
    /var\s+ytInitialData\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /window\["ytInitialData"\]\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /ytInitialData\s*=\s*({[\s\S]+?});\s*<\/script>/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      return JSON.parse(m[1]);
    } catch {
      // Try the next pattern — YouTube occasionally injects extra
      // trailing characters that break a greedy match.
    }
  }
  return null;
}

/**
 * Walk the parsed ytInitialData looking for `videoRenderer` items.
 * The structure is deeply nested and changes shape between
 * desktop/mobile variants, so we recurse with a depth cap and
 * collect anything that looks like a video. Returned items are
 * de-duplicated by videoId in caller order.
 */
function harvestVideosFromInitialData(
  data: unknown,
  limit: number,
): YoutubeSearchResult[] {
  const out: YoutubeSearchResult[] = [];
  const seen = new Set<string>();
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: data, depth: 0 },
  ];
  const MAX_DEPTH = 30;

  while (stack.length > 0 && out.length < limit) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') {
      continue;
    }
    const obj = node as Record<string, unknown>;
    const renderer = obj.videoRenderer;
    if (renderer && typeof renderer === 'object') {
      const r = renderer as Record<string, unknown>;
      const videoId = typeof r.videoId === 'string' ? r.videoId : '';
      if (videoId && !seen.has(videoId) && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        seen.add(videoId);
        out.push({
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          title: extractRunsText(r.title),
          channel: extractRunsText(r.ownerText) ?? extractRunsText(r.longBylineText),
          durationText: extractSimpleText(r.lengthText),
        });
        // Don't descend into the renderer we just claimed.
        continue;
      }
    }
    // Push children. Order doesn't matter for correctness but keeps
    // the stack manageable.
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        stack.push({ node: v, depth: depth + 1 });
      }
    }
  }
  return out;
}

/** Pull text out of YouTube's `{ runs: [{ text }] }` envelope. */
function extractRunsText(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { runs?: unknown; simpleText?: unknown };
  if (typeof n.simpleText === 'string') return n.simpleText;
  if (Array.isArray(n.runs)) {
    const parts: string[] = [];
    for (const r of n.runs) {
      if (r && typeof r === 'object') {
        const t = (r as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  return undefined;
}

/** Pull text out of YouTube's `{ simpleText }` envelope. */
function extractSimpleText(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as { simpleText?: unknown };
  return typeof n.simpleText === 'string' ? n.simpleText : undefined;
}

/**
 * Fallback path: pull every `/watch?v=ID` URL out of the raw HTML.
 * Loses titles and channels but guarantees the URLs we return are
 * really present in YouTube's response — which is the whole point.
 */
function harvestVideosFromRawHtml(
  html: string,
  limit: number,
): YoutubeSearchResult[] {
  const out: YoutubeSearchResult[] = [];
  const seen = new Set<string>();
  const re = /\/watch\?v=([A-Za-z0-9_-]{11})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const videoId = m[1];
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    out.push({
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return out;
}

/**
 * Fetch the results page with a hard timeout, returning the response
 * body as a string. Errors propagate to the caller as a tool-level
 * failure so the model sees what went wrong (network down,
 * rate limit, etc.) instead of a silent empty list.
 */
async function fetchResultsPage(query: string): Promise<string> {
  const url = buildSearchUrl(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: browserHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(
        `YouTube results page returned HTTP ${res.status} ${res.statusText}`,
      );
    }
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `youtube_search timed out after ${FETCH_TIMEOUT_MS} ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const youtubeSearchTool: ToolHandler = {
  schema: {
    name: 'youtube_search',
    description:
      'Search YouTube and return real /watch?v= URLs (with title + channel ' +
      'when extractable). Use this before browser_navigate for media requests in durable Jobs. ' +
      'Navigate only to a URL returned by this tool, never a URL composed by the model. ' +
      'Navigation alone does not prove playback; inspect the player, use the permitted play control if needed, and verify playback before claiming it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query — typically `<song title> <artist> official audio`.',
        },
        limit: {
          type: 'number',
          description: `Max results (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        },
      },
      required: ['query'],
    },
  },
  category: 'network',
  mutates: false,
  toolset: 'web',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return { success: false, error: 'No query provided' };
    }
    const requestedLimit =
      typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, requestedLimit));

    let html: string;
    try {
      html = await fetchResultsPage(query);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Preferred path — JSON gives us titles. Fall through to raw
    // regex when the JSON path returns nothing (YouTube variant we
    // don't recognise) or breaks (HTML structure changed).
    let results: YoutubeSearchResult[] = [];
    const initialData = extractInitialData(html);
    if (initialData) {
      results = harvestVideosFromInitialData(initialData, limit);
    }
    if (results.length === 0) {
      results = harvestVideosFromRawHtml(html, limit);
    }

    if (results.length === 0) {
      return {
        success: false,
        error:
          'YouTube results page contained no /watch?v= URLs. The query ' +
          'may have returned a non-video page (channel/playlist) or YouTube ' +
          'changed its HTML. Retry with a different query.',
        query,
      };
    }

    return {
      success: true,
      query,
      count: results.length,
      results,
    };
  },
};
