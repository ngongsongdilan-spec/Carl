import type { Database, Row } from './database.js';
import type {
  AttentionCategory,
  AttentionItem,
  DeterministicVerdict,
  ItemStatus,
  NormalizedEmail,
  Priority,
} from '../domain/types.js';

export type { AttentionItem };
import { makeExcerpt } from '../mail/normalize.js';

/**
 * Repositories.
 *
 * All persistence lives here, behind plain functions. Replacing SQLite with
 * Postgres means rewriting this file and nothing else.
 *
 * Note what is NOT stored: full email bodies. `body_excerpt` is capped at
 * config.bodyExcerptChars so the database cannot become a shadow mailbox.
 */

const nowIso = (): string => new Date().toISOString();

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export interface MessageRecord {
  gmailId: string;
  /** Alias kept for readability at call sites dealing in Gmail terminology. */
  messageId?: string;
  threadId: string;
  fromAddr: string;
  fromName: string | null;
  fromDomain: string | null;
  subject: string;
  snippet: string;
  bodyExcerpt: string;
  bodyChars: number;
  internalDate: number;
  labels: string[];
  isNoise: boolean;
  noiseKind: string | null;
  analysedAt: string | null;
  fetchedAt: string;
}

export interface MessageInput {
  email: NormalizedEmail;
  isNoise: boolean;
  noiseKind: string | null;
  bodyExcerptChars: number;
}

export function upsertMessage(db: Database, input: MessageInput): void {
  const { email } = input;
  const excerpt = makeExcerpt(email.bodyText, input.bodyExcerptChars);
  db.run(
    `INSERT INTO messages (
       gmail_id, thread_id, from_addr, from_name, from_domain, subject, snippet,
       body_excerpt, body_chars, internal_date, labels_json, is_noise, noise_kind,
       analysed_at, fetched_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(gmail_id) DO UPDATE SET
       thread_id = excluded.thread_id,
       from_addr = excluded.from_addr,
       from_name = excluded.from_name,
       from_domain = excluded.from_domain,
       subject = excluded.subject,
       snippet = excluded.snippet,
       body_excerpt = excluded.body_excerpt,
       body_chars = excluded.body_chars,
       internal_date = excluded.internal_date,
       labels_json = excluded.labels_json,
       is_noise = excluded.is_noise,
       noise_kind = excluded.noise_kind,
       analysed_at = NULL,
       fetched_at = excluded.fetched_at`,
    [
      email.id,
      email.threadId,
      email.fromAddress,
      email.fromName,
      email.fromDomain,
      email.subject,
      email.snippet.slice(0, 400),
      excerpt,
      email.bodyText.length,
      email.date.getTime(),
      JSON.stringify(email.labels),
      boolToInt(input.isNoise),
      input.noiseKind,
      null,
      nowIso(),
    ],
  );
}

export function getMessage(db: Database, gmailId: string): MessageRecord | null {
  const row = db.get<Row>('SELECT * FROM messages WHERE gmail_id = ?', [gmailId]);
  return row ? toMessageRecord(row) : null;
}

export function getSourceInfo(
  db: Database,
  gmailId: string,
): { fromAddr: string; fromName: string | null; subject: string; excerpt: string; internalDate: number } | null {
  const row = db.get<Row>(
    'SELECT from_addr, from_name, subject, body_excerpt, internal_date FROM messages WHERE gmail_id = ?',
    [gmailId],
  );
  if (!row) return null;
  return {
    fromAddr: String(row.from_addr ?? ''),
    fromName: row.from_name ? String(row.from_name) : null,
    subject: String(row.subject ?? ''),
    excerpt: String(row.body_excerpt ?? ''),
    internalDate: Number(row.internal_date ?? 0),
  };
}

export function getMessageIdsByThread(db: Database, threadId: string): string[] {
  return db
    .all<Row>('SELECT gmail_id FROM messages WHERE thread_id = ? ORDER BY internal_date ASC', [threadId])
    .map((r) => String(r.gmail_id));
}

function toMessageRecord(row: Row): MessageRecord {
  return {
    gmailId: String(row.gmail_id),
    messageId: String(row.gmail_id),
    threadId: String(row.thread_id),
    fromAddr: String(row.from_addr),
    fromName: row.from_name ? String(row.from_name) : null,
    fromDomain: row.from_domain ? String(row.from_domain) : null,
    subject: String(row.subject ?? ''),
    snippet: String(row.snippet ?? ''),
    bodyExcerpt: String(row.body_excerpt ?? ''),
    bodyChars: Number(row.body_chars ?? 0),
    internalDate: Number(row.internal_date ?? 0),
    labels: parseJson<string[]>(row.labels_json, []),
    isNoise: Number(row.is_noise) === 1,
    noiseKind: row.noise_kind ? String(row.noise_kind) : null,
    analysedAt: row.analysed_at ? String(row.analysed_at) : null,
    fetchedAt: String(row.fetched_at ?? ''),
  };
}

// ---------------------------------------------------------------------------
// analyses
// ---------------------------------------------------------------------------

export interface AnalysisRecord {
  messageId: string;
  threadId: string;
  category: string;
  isAttention: boolean;
  priority: string;
  confidence: number;
  title: string;
  summary: string;
  why: string;
  action: string;
  deadlineIso: string | null;
  deadlineRaw: string | null;
  decidedBy: string;
  suppression: string | null;
  signals: unknown[];
  createdAt: string;
}

export function saveAnalysis(
  db: Database,
  messageId: string,
  threadId: string,
  verdict: DeterministicVerdict,
  decidedBy: string,
): void {
  db.run(
    `INSERT INTO analyses (
       message_id, thread_id, category, is_attention, priority, confidence, title,
       summary, why, action, deadline_iso, deadline_raw, decided_by, suppression,
       signals_json, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(message_id) DO UPDATE SET
       thread_id = excluded.thread_id,
       category = excluded.category,
       is_attention = excluded.is_attention,
       priority = excluded.priority,
       confidence = excluded.confidence,
       title = excluded.title,
       summary = excluded.summary,
       why = excluded.why,
       action = excluded.action,
       deadline_iso = excluded.deadline_iso,
       deadline_raw = excluded.deadline_raw,
       decided_by = excluded.decided_by,
       suppression = excluded.suppression,
       signals_json = excluded.signals_json,
       created_at = excluded.created_at`,
    [
      messageId,
      threadId,
      verdict.category,
      boolToInt(verdict.isAttentionItem),
      verdict.priority,
      verdict.confidence,
      verdict.title,
      verdict.summary,
      verdict.whyItMatters,
      verdict.recommendedAction,
      verdict.deadline.iso,
      verdict.deadline.raw,
      decidedBy,
      verdict.suppressionReason,
      JSON.stringify(verdict.signals.map((s) => ({ kind: s.kind, weight: s.weight }))),
      nowIso(),
    ],
  );
  db.run('UPDATE messages SET analysed_at = ? WHERE gmail_id = ?', [nowIso(), messageId]);
}

export function getAnalysis(db: Database, messageId: string): AnalysisRecord | null {
  const row = db.get<Row>('SELECT * FROM analyses WHERE message_id = ?', [messageId]);
  if (!row) return null;
  return {
    messageId: String(row.message_id),
    threadId: String(row.thread_id ?? ''),
    category: String(row.category),
    isAttention: Number(row.is_attention) === 1,
    priority: String(row.priority),
    confidence: Number(row.confidence ?? 0),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    why: String(row.why ?? ''),
    action: String(row.action ?? ''),
    deadlineIso: row.deadline_iso ? String(row.deadline_iso) : null,
    deadlineRaw: row.deadline_raw ? String(row.deadline_raw) : null,
    decidedBy: String(row.decided_by ?? 'rules'),
    suppression: row.suppression ? String(row.suppression) : null,
    signals: parseJson<unknown[]>(row.signals_json, []),
    createdAt: String(row.created_at ?? ''),
  };
}

export function countAnalyses(db: Database): number {
  return Number(db.get<Row>('SELECT COUNT(*) AS n FROM analyses')?.n ?? 0);
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

export interface NewItem {
  id: string;
  eventKey: string;
  threadId: string | null;
  sourceMessageId: string;
  sourceThreadId: string | null;
  category: AttentionCategory;
  priority: Priority;
  confidence: number;
  title: string;
  summary: string;
  why: string;
  action: string;
  deadlineIso: string | null;
  deadlineRaw: string | null;
  status: ItemStatus;
  resolvedReason: string | null;
  decidedBy: string;
}

export function insertItem(db: Database, item: NewItem): AttentionItem {
  const ts = nowIso();
  db.run(
    `INSERT INTO items (
       id, event_key, thread_id, source_message_id, source_thread_id, category,
       priority, confidence, title, summary, why, action, deadline_iso,
       deadline_raw, status, resolved_reason, decided_by, notified_at,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    [
      item.id,
      item.eventKey,
      item.threadId,
      item.sourceMessageId,
      item.sourceThreadId,
      item.category,
      item.priority,
      item.confidence,
      item.title,
      item.summary,
      item.why,
      item.action,
      item.deadlineIso,
      item.deadlineRaw,
      item.status,
      item.resolvedReason,
      item.decidedBy,
      ts,
      ts,
    ],
  );
  recordItemEvent(db, item.id, 'created');
  return getItem(db, item.id) as AttentionItem;
}

export function getItem(db: Database, id: string): AttentionItem | null {
  const row = db.get<Row>('SELECT * FROM items WHERE id = ?', [id]);
  return row ? toItem(row) : null;
}

export function findItemByEventKey(db: Database, eventKey: string): AttentionItem | null {
  const row = db.get<Row>('SELECT * FROM items WHERE event_key = ?', [eventKey]);
  return row ? toItem(row) : null;
}

export interface ListItemsOptions {
  statuses?: ItemStatus[];
  limit?: number;
  minConfidence?: number;
}

export function listItems(db: Database, options: ListItemsOptions = {}): AttentionItem[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.statuses && options.statuses.length > 0) {
    clauses.push(`status IN (${options.statuses.map(() => '?').join(',')})`);
    params.push(...options.statuses);
  }
  if (typeof options.minConfidence === 'number') {
    clauses.push('confidence >= ?');
    params.push(options.minConfidence);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  params.push(limit);

  // `where` is built only from the fixed fragments pushed into `clauses` above,
  // each of which is a literal containing `?`. Every actual value travels in
  // `params`. `limit` is an integer clamped on the line above, used for the
  // placeholder count.
  const rows = db.all<Row>(
    `SELECT * FROM items ${where}
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              confidence DESC,
              COALESCE(deadline_iso, '9999') ASC,
              created_at DESC
     LIMIT ?`,
    params,
  );
  return rows.map(toItem);
}

export function updateItemStatus(
  db: Database,
  id: string,
  status: ItemStatus,
  reason: string | null = null,
): AttentionItem | null {
  const existing = getItem(db, id);
  if (!existing) return null;
  db.run(
    'UPDATE items SET status = ?, resolved_reason = ?, updated_at = ? WHERE id = ?',
    [status, reason, nowIso(), id],
  );
  recordItemEvent(db, id, `status:${status}`);
  return getItem(db, id);
}

export function markNotified(db: Database, id: string): void {
  db.run('UPDATE items SET notified_at = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    nowIso(),
    id,
  ]);
  recordItemEvent(db, id, 'notified');
}

export function deleteItem(db: Database, id: string): boolean {
  const existing = getItem(db, id);
  if (!existing) return false;
  db.run('DELETE FROM items WHERE id = ?', [id]);
  return true;
}

export function listUnnotifiedOpenItems(
  db: Database,
  minConfidence: number,
): AttentionItem[] {
  const rows = db.all<Row>(
    `SELECT * FROM items
     WHERE status = 'open' AND notified_at IS NULL AND confidence >= ?
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              confidence DESC`,
    [minConfidence],
  );
  return rows.map(toItem);
}

export function countOpenItems(db: Database): number {
  return countItemsByStatus(db, ['open']);
}

/**
 * Exact per-status totals.
 *
 * Counting in SQL rather than through `listItems`: the list is capped by a
 * `limit`, so measuring a count by listing items silently reports 0 or 1 and
 * cannot distinguish "none" from "more than the page size".
 */
export function countItemsByStatus(db: Database, statuses: ItemStatus[]): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => '?').join(',');
  const row = db.get<Row>(
    `SELECT COUNT(*) AS n FROM items WHERE status IN (${placeholders})`,
    statuses,
  );
  return Number(row?.n ?? 0);
}

export function recordItemEvent(db: Database, itemId: string, kind: string): void {
  db.run('INSERT INTO item_events (item_id, kind, at) VALUES (?,?,?)', [
    itemId,
    kind,
    nowIso(),
  ]);
}

export function listItemEvents(db: Database, itemId: string): { kind: string; at: string }[] {
  return db
    .all<Row>('SELECT kind, at FROM item_events WHERE item_id = ? ORDER BY at ASC', [itemId])
    .map((r) => ({ kind: String(r.kind), at: String(r.at) }));
}

function toItem(row: Row): AttentionItem {
  return {
    id: String(row.id),
    eventKey: String(row.event_key),
    threadId: row.thread_id ? String(row.thread_id) : null,
    sourceMessageId: String(row.source_message_id),
    sourceThreadId: row.source_thread_id ? String(row.source_thread_id) : null,
    category: String(row.category) as AttentionCategory,
    priority: String(row.priority) as Priority,
    confidence: Number(row.confidence ?? 0),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    whyItMatters: String(row.why ?? ''),
    recommendedAction: String(row.action ?? ''),
    deadlineIso: row.deadline_iso ? String(row.deadline_iso) : null,
    deadlineRaw: row.deadline_raw ? String(row.deadline_raw) : null,
    status: String(row.status) as ItemStatus,
    resolvedReason: row.resolved_reason ? String(row.resolved_reason) : null,
    decidedBy: String(row.decided_by ?? 'rules'),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    notifiedAt: row.notified_at ? String(row.notified_at) : null,
  };
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

export interface StoredTokens {
  accessToken: string | null;
  refreshToken: string | null;
  expiryMs: number | null;
  scope: string | null;
  accountEmail: string | null;
}

export function saveTokens(db: Database, tokens: StoredTokens): void {
  db.run(
    `INSERT INTO tokens (id, access_token, refresh_token, expiry_ms, scope, account_email, updated_at)
     VALUES (1,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expiry_ms = excluded.expiry_ms,
       scope = excluded.scope,
       account_email = excluded.account_email,
       updated_at = excluded.updated_at`,
    [
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiryMs,
      tokens.scope,
      tokens.accountEmail,
      nowIso(),
    ],
  );
}

export function loadTokens(db: Database): StoredTokens | null {
  const row = db.get<Row>('SELECT * FROM tokens WHERE id = 1');
  if (!row) return null;
  if (!row.refresh_token && !row.access_token) return null;
  return {
    accessToken: row.access_token ? String(row.access_token) : null,
    refreshToken: row.refresh_token ? String(row.refresh_token) : null,
    expiryMs: row.expiry_ms ? Number(row.expiry_ms) : null,
    scope: row.scope ? String(row.scope) : null,
    accountEmail: row.account_email ? String(row.account_email) : null,
  };
}

export function clearTokens(db: Database): void {
  db.run('DELETE FROM tokens WHERE id = 1');
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  analysed: number;
  skipped: number;
  itemsOpen: number;
  aiCalls: number;
  degraded: boolean;
  error: string | null;
}

export function startRun(db: Database, id: string): void {
  db.run('INSERT INTO runs (id, started_at) VALUES (?,?)', [id, nowIso()]);
}

export function finishRun(
  db: Database,
  id: string,
  fields: Partial<Omit<RunRow, 'id' | 'startedAt'>>,
): void {
  db.run(
    `UPDATE runs SET finished_at = ?, fetched = ?, analysed = ?, skipped = ?,
       items_open = ?, ai_calls = ?, degraded = ?, error = ? WHERE id = ?`,
    [
      nowIso(),
      fields.fetched ?? 0,
      fields.analysed ?? 0,
      fields.skipped ?? 0,
      fields.itemsOpen ?? 0,
      fields.aiCalls ?? 0,
      boolToInt(fields.degraded ?? false),
      fields.error ?? null,
      id,
    ],
  );
}

export function lastRun(db: Database): RunRow | null {
  const row = db.get<Row>('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1');
  if (!row) return null;
  return {
    id: String(row.id),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    fetched: Number(row.fetched ?? 0),
    analysed: Number(row.analysed ?? 0),
    skipped: Number(row.skipped ?? 0),
    itemsOpen: Number(row.items_open ?? 0),
    aiCalls: Number(row.ai_calls ?? 0),
    degraded: Number(row.degraded) === 1,
    error: row.error ? String(row.error) : null,
  };
}
