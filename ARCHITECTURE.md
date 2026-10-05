# Architecture

## 1. Shape

A single-process TypeScript backend owns everything sensitive. The frontend is a
static bundle that never sees a secret, a token, or a raw email body.

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (React + Vite, :5173)                               │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │ Connect      │  │ Attention   │  │ Notification layer   │ │
│  │ Gmail state  │  │ feed + cards│  │ (Notification API)   │ │
│  └──────┬───────┘  └──────┬──────┘  └──────────▲───────────┘ │
└─────────┼─────────────────┼─────────────────────┼─────────────┘
          │ JSON            │ SSE (/api/stream)   │
┌─────────▼─────────────────▼─────────────────────┼─────────────┐
│  Backend API (Express, :8787)                  │             │
│  ┌────────────────────────────────────────┐   │             │
│  │ routes/  auth · mail · attention · ask  │   │             │
│  ├────────────────────────────────────────┤   │             │
│  │ services/  Pipeline · Assistant         │   │             │
│  │            NotificationService          │───┘             │
│  ├────────────────────────────────────────┤                   │
│  │ ATTENTION ENGINE                        │                   │
│  │  1 Normalize → 2 Prefilter → 3 Thread   │                   │
│  │  → 4 Signals → 5 Resolve → 6 Merge      │                   │
│  ├────────────────┬────────────────────────┤                   │
│  │ AIProvider     │ MailProvider           │                   │
│  │ ├ heuristic    │ └ GmailService          │                   │
│  │ └ openaiCompat │   (googleapis)         │                   │
│  └────────────────┴────────────────────────┘                   │
│  ┌────────────────────────────────────────┐                   │
│  │ Persistence (node:sqlite, ./data)       │                   │
│  └────────────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     Google Gmail API (read-only)
```

## 2. Design rules

1. **Interfaces at every external boundary.** `MailProvider`, `AIProvider`,
   `NotificationService`, `Clock`. Swapping in Outlook, Anthropic, or APNs touches one
   file plus one line of wiring.
2. **Deterministic first, AI second.** Rules decide cheap and certain things. The AI is
   consulted only where it adds value, and its output is validated rather than trusted.
3. **No trust in model output.** Every AI response goes through a zod schema, is clamped,
   and falls back to the deterministic result on any failure.
4. **Secrets stay server-side.** Tokens live in SQLite on disk. The API returns only
   `connected: boolean`.
5. **Bounded work.** Message limit, AI call cap, pagination, and a cache. No full-mailbox
   scans.

## 3. The attention engine pipeline

This is the core. Input is a list of raw Gmail messages; output is a deduplicated,
ranked list of `AttentionItem`s.

### Stage 0 — Thread hydration (`pipeline/pipeline.ts`)

Before stage 1, each fetched message is replaced with its full thread
(`MailProvider.fetchThread`), deduplicated by message id.

This step exists because of how Gmail is queried. The default query is
`in:anywhere -category:promotions -is:sent`, which deliberately excludes mail the
user sent. That is good for noise reduction and terrible for correctness: a reply the
user already wrote is invisible, so a request they have answered looks unanswered and
the engine keeps resurfacing it. Resolution detection in stage 5 works on thread
history, so without the thread fetch it cannot fire for real mail.

A thread fetch that fails is not fatal. The run proceeds with the messages already
known; the worst case is a resurfaced item rather than no analysis at all. The demo
path passes a complete message list and skips this stage entirely.

### Stage 1 — Normalize (`attention/normalize.ts`)

MIME → `NormalizedEmail`: decoded subject (`=?UTF-8?B?…?=`), parsed sender name/address,
plain-text body (HTML stripped, signatures and tracking pixels removed), snippet,
internal date, Gmail labels, thread id. Nothing here decides importance; it only makes the
input trustworthy. Every field is optional-tolerant — a malformed email must never crash
the run.

### Stage 2 — Prefilter (`attention/prefilter.ts`)

Cheap, deterministic, and the main cost control. An email is classified as `noise`
(newsletters, promotions, ads, receipts, routine notifications, spam) when it carries
strong structural evidence:

- `Precedence: bulk` / `List-Unsubscribe` / `List-Id` headers
- Gmail categories `promotions` / `social` / `updates` combined with unsubscribe links
- Marketing vocabulary (`unsubscribe`, `you are receiving this`, `%promo%`) plus no
  request-shaped language
- No question, no imperative, no deadline, no first-person obligation

A *structural* signal such as a personal sender, a question, an action verb, or a deadline
overrides the noise verdict. This stage never sees the AI. It is why 100 messages cost a
handful of model calls rather than 100.

### Stage 3 — Thread context (`attention/threader.ts`)

Messages are grouped by `threadId`, ordered by time, and each message is annotated with
its position (first / latest), the participants, and whether the user has already replied
in that thread. Analysis happens at the **thread** level for threads with more than one
message, because a request is not meaningful without its history.

### Stage 4 — Signals (`attention/signals.ts`)

Rule extractors produce typed, *explainable* evidence rather than a single number:

| Signal | Detects |
| --- | --- |
| `action_request` | imperatives, "please …", request phrases, CTA buttons |
| `question` | direct questions addressed to the reader |
| `obligation` | "you must", "required", "mandatory", "failure to … will" |
| `deadline` | absolute dates, "within N days", "by <date>", expiry language |
| `urgency` | "urgent", "immediately", "final notice", "act now", "expires" |
| `consequence` | "your account will be", "access will be", "suspended", "deleted" |
| `financial` | amount + "due", "outstanding", "overdue", "failed" |
| `security` | "new sign-in", "password changed", "suspicious activity" |
| `expiry` | "expires on", "valid until", "expiring" |
| `resolution` | "completed", "resolved", "all set", "no longer", "thank you for" |
| `personal` | first-person, direct address, known-user name |
| `automated_noop` | "receipt for your purchase", "delivery scheduled", "no action needed" |

`deadline` produces a structured `Deadline { iso, raw, kind: explicit|relative, confidence }`
rather than a string, which is what lets the UI say "no deadline detected" honestly.

### Stage 5 — Resolve (`attention/resolve.ts`)

The stage the spec cares most about. An open request in a thread is closed when:

- a later message in the thread contains a resolution marker from the other party, or
- the user themselves replied with a completion/thanks marker, or
- the request's deadline has already passed, or
- the latest message explicitly withdraws the request ("ignore my previous email")

Resolved items are stored with `status = 'resolved'` and never appear as open attention.
This is why "please verify your account" followed by "your verification is complete"
produces zero open items.

### Stage 6 — Merge, dedupe, rank (`attention/merge.ts`, `attention/dedupe.ts`)

Deterministic and AI verdicts are combined:

- **Category**: AI wins if confident and valid, else deterministic.
- **Priority**: the stricter of the two, escalated by urgency/consequence signals.
- **Confidence**: deterministic base confidence per signal strength, adjusted by agreement
  between rule and AI, clamped to `[0,1]`. A single weak keyword never yields high
  confidence.
- **Dedupe key**: `category + normalized entity + time bucket`, plus thread id. Two emails
  about the same event inside the same thread collapse to one item; the newest message
  wins and the other becomes `superseded`.

Items below `ATTENTION_MIN_CONFIDENCE` are stored as `noise` for auditing but never shown.

## 4. Layering decisions

**Why not send everything to the AI?** Cost, latency, and — more importantly — accuracy.
Asking a model "is this important?" on a newsletter produces occasional false positives at
random. Cheap structural filters are more reliable for the obvious 80% of noise, and they
are free and instant.

**Why keep the deterministic analyzer as a *provider* rather than a fallback branch?** It
is the same interface as the AI one, so it is directly testable, and `AI_MODE=off` makes
the app fully functional with no API key. No code path depends on an AI existing.

**Why threads?** Importance is a property of a *situation*, not of a message. "Re: your
invoice" is unremarkable in isolation and urgent next to "invoice overdue". Thread-level
analysis gets this right structurally instead of by keyword matching.

## 5. Data model

```sql
messages   (gmail_id PK, thread_id, from_addr, from_name, subject, snippet,
            body_excerpt, internal_date, labels_json, is_noise, analysed_at)
analyses   (message_id PK, category, is_attention, priority, confidence,
            title, summary, why, action, deadline_iso, deadline_raw,
            suppression, decided_by, signals_json, created_at)
items      (id PK, event_key UNIQUE, thread_id, source_message_id, category,
            priority, confidence, title, summary, why, action, deadline_iso,
            status, reason, created_at, updated_at, notified_at)
item_events(item_id, kind, at)
tokens     (singleton, refresh_token, access_token, expiry, scope, email)
runs       (id, started_at, finished_at, fetched, analysed, items, error)
```

Deliberate omissions: no user table (single-user local tool), no attachment storage, no
full body retention. `body_excerpt` is capped at 600 characters and exists so the UI can
show *why* an item was raised without re-fetching.

`analyses` holds both outcomes: raised items (`is_attention = 1`) and suppressed ones
(`is_attention = 0` with a `suppression` reason). Persisting the second kind is what makes
`GET /api/debug/suppressed` answer "why was this filtered?" per message rather than
returning only run-level totals.

## 6. Error handling

Typed `AppError` with an HTTP status and a stable `code`. Every route returns
`{ error: { code, message, hint } }`. The three failure modes that matter most:

- **AI down** → deterministic result, `degraded: true` in the response, UI shows an
  "AI analysis is temporarily unavailable" banner. Never a crash.
- **Token expired** → refresh automatically; on refresh failure, mark disconnected and
  return `401` with a clear message.
- **Gmail quota/rate limit** → abort the run cleanly, record it in `runs`, keep previously
  known items.

## 7. Replaceability

| Boundary | Interface | Swap in |
| --- | --- | --- |
| Mail | `MailProvider` | Outlook/IMAP via one new class |
| AI | `AIProvider` | Anthropic/Gemini/local via one new class |
| Notify | `NotificationService` | Push/APNs/email |
| Storage | repository functions | Postgres by reimplementing `db/repositories.ts` |
| Time | `Clock` | deterministic tests |

The pipeline depends only on these interfaces, which is why the demo path and the Gmail
path share every line of analysis logic.

## 8. Testing strategy

- **Engine tests** are pure-function tests over fixtures — no DB, no HTTP, no mocks of
  our own code. This is where the real coverage is.
- **Anti-slop tests** assert a mostly-noise corpus yields few or no items.
- **AI provider tests** cover valid output, garbage output, missing fields, wrong types,
  timeouts, and non-200 responses; each must degrade to deterministic.
- **Gmail tests** run against a mocked `fetch`, covering pagination, token refresh, and
  quota errors.
- **API tests** use `supertest` against a real app instance with a temp SQLite file.
- **Pipeline tests** drive `Pipeline.run` against a fake `MailProvider` that can return
  a partial thread, to prove hydration happens, dedupes correctly, and degrades cleanly
  when a thread fetch fails.
- **Demo-shift tests** run the demo corpus through the engine with the *real* clock. The
  demo shifts fixtures to "now"; without this, a fixture could be shifted into a state
  that silently deletes the scenario it exists to demonstrate (a security alert pushed
  past its own 24-hour deadline, or an expired deadline becoming live).
