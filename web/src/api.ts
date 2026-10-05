/**
 * API client.
 *
 * Every response from the backend is treated as untrusted input: shapes are
 * checked at runtime before use, and error bodies are surfaced verbatim because
 * the server sends user-facing messages.
 */

const BASE = '/api';

export interface ApiErrorShape {
  code: string;
  message: string;
  hint: string | null;
}

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly status: number;

  constructor(status: number, shape: ApiErrorShape) {
    super(shape.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = shape.code;
    this.hint = shape.hint;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, {
      code: 'network_error',
      message: 'Cannot reach the backend. Is the server running?',
      hint: 'Start it with `npm run dev`, or `npm start` if you built the frontend.',
    });
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const errorBody = body as { error?: ApiErrorShape } | null;
    throw new ApiError(
      response.status,
      errorBody?.error ?? {
        code: 'unexpected_error',
        message: `Request failed with status ${response.status}.`,
        hint: null,
      },
    );
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Types (mirror of the server's AttentionItemView projection)
// ---------------------------------------------------------------------------

export type Priority = 'high' | 'medium' | 'low';
export type ItemStatus = 'open' | 'handled' | 'dismissed' | 'resolved';

export interface DeadlineView {
  iso: string;
  raw: string;
  kind: string;
  confidence: number;
}

export interface AttentionItemView {
  id: string;
  priority: Priority;
  category: string;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  deadline: DeadlineView | null;
  confidence: number;
  status: ItemStatus;
  sourceMessageId: string;
  sourceThreadId: string | null;
  gmailUrl: string;
  source: {
    sender: string;
    subject: string;
    receivedAt: string;
    excerpt: string;
  };
  createdAt: string;
  updatedAt: string;
  decidedBy: string;
}

export interface AuthStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  setupHint: string | null;
  redirectUri: string | null;
}

export interface AppConfigView {
  ai: {
    mode: string;
    provider: string;
    available: boolean;
    model: string | null;
    detail: string;
  };
  attention: {
    messageLimit: number;
    minConfidence: number;
    notifyMode: string;
  };
  demoMode: boolean;
}

export interface AttentionListResponse {
  items: AttentionItemView[];
  counts: Record<ItemStatus, number>;
}

export interface AnalyzeResponse {
  run: {
    fetched: number;
    analysed: number;
    skippedNoise: number;
    newItems: number;
    openItems: number;
    aiCalls: number;
    degraded: boolean;
    durationMs: number;
  };
  items: AttentionItemView[];
}

export interface AskResponse {
  answer: string;
  citedItemIds: string[];
  source: string;
  outOfScope: boolean;
}

export interface SourceResponse {
  available: boolean;
  gmailUrl: string;
  from?: string;
  subject?: string;
  receivedAt?: string;
  excerpt?: string;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  authStatus: () => request<AuthStatus>('/auth/status'),

  disconnect: () => request<{ connected: boolean }>('/auth/disconnect', { method: 'POST' }),

  config: () => request<AppConfigView>('/config'),

  listAttention: (status: 'open' | 'all' = 'open') =>
    request<AttentionListResponse>(`/attention?status=${encodeURIComponent(status)}`),

  markHandled: (id: string) =>
    request<{ item: AttentionItemView | null }>(`/attention/${encodeURIComponent(id)}/handled`, {
      method: 'POST',
    }),

  dismiss: (id: string) =>
    request<{ item: AttentionItemView | null }>(`/attention/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    }),

  reopen: (id: string) =>
    request<{ item: AttentionItemView | null }>(`/attention/${encodeURIComponent(id)}/reopen`, {
      method: 'POST',
    }),

  source: (id: string) =>
    request<SourceResponse>(`/attention/${encodeURIComponent(id)}/source`),

  analyze: (options: { limit?: number; demo?: boolean }) =>
    request<AnalyzeResponse>('/analyze', {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  ask: (question: string) =>
    request<AskResponse>('/ask', {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),
};

/**
 * The OAuth flow must be a top-level navigation, not fetch: Google redirects
 * the browser, and the callback then redirects back to the app.
 */
export function beginGoogleAuth(): void {
  window.location.assign(`${BASE}/auth/google`);
}
