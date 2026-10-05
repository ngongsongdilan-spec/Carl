# Personal Attention Engine

**Status:** MVP implemented and runnable locally.

---

## 1. What this is

An email inbox contains a lot of *activity* and very little *signal*. This app is a
personal attention engine: it reads a bounded window of recent Gmail, works out which
messages represent a real obligation or risk, and presents a short list of things that
genuinely deserve your attention — each with an explanation of **why** it matters and a
**recommended action**.

It is not a mailbox, not a summarizer, and not a chatbot. It answers one question well:

> What needs my attention right now?

A quiet inbox producing **"No important items right now."** is a success, not a failure.

---

## 2. Quick start (5 minutes, no Google setup)

This path runs the complete engine and UI against the built-in test fixtures. No Gmail
account, no API keys.

**Prerequisites:** Node 22.5+ (Node 24 recommended) and npm. Nothing else — no database
server, no compiler toolchain.

```bash
# 1. install
npm install

# 2. configure (optional for the demo path)
copy .env.example .env        # Windows CMD
# cp .env.example .env        # macOS / Linux

# 3. run backend + frontend together
npm run dev
```

Open <http://localhost:5173>.

Click **Load demo inbox** on the connection screen. The app analyses 12 fixture emails
(newsletters, ads, a receipt, a security alert, a domain verification, a university
deadline, a meeting request, a resolved request, an expired deadline, an announcement,
and a multi-message thread) and shows only the 5–7 that genuinely deserve attention.

The demo runs the *real* pipeline: real RFC822 messages, the production MIME parser,
the real engine, the real database. Nothing about it is a stub. Fixture dates are shifted
relative to today so the deadlines are live whenever you run it.

### Running it as a single process

```bash
npm run build     # produces web/dist
npm start         # serves the UI and the API together on :8787
```

Requires **Node 22.5 or newer** (Node 24 recommended). The database uses Node's built-in
`node:sqlite`, so there is no native module to compile and no build toolchain to install.

Then open <http://localhost:8787>. Use this when you want the app to look exactly as it
would in production, or when you are not running Vite.

### Running the demo with no frontend

```bash
npm run seed     # prints the engine's verdict on the fixtures, no browser needed
npm test         # full automated suite
```

`npm run seed` is the fastest way to see what the engine actually decided. It prints
the feed, then everything it *suppressed* and why — which is the more informative half:

```
[HIGH] Action required: verify registrant contact for example.com
  category   verification
  confidence 0.98 (rules)
  deadline   within 7 days
  why        This kind of verification is often required before an account keeps working.
  action     Please complete identity verification for example.

SUPPRESSED (6) - what was deliberately not shown
  noise              newsletter      Filtered as newsletter.
  noise              advertisement   Filtered as advertisement.
  deadline_passed    account_security The deadline has passed ("within 24 hours").
  resolved_in_thread requirement     Resolved in a later message in the same thread.
```

---

## 3. Connecting real Gmail

### 3.1 Create a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in with the Google account whose
   inbox you want to analyse.
2. At the top of the page use the project picker to **create a new project** (or select
   an existing one).
3. Keep the project open. You will use it for the next two steps.

### 3.2 Enable the Gmail API

1. With your project selected, open
   **APIs & Services > Library**.
2. Search for **Gmail API** and click it.
3. Click **Enable**.

### 3.3 Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**.
2. If prompted, choose **External**. (You do not need Google Workspace for this.)
3. Fill in:
   - **App name**: `Personal Attention Engine`
   - **User support email**: your own address
   - **Developer contact information**: your own address
4. Under **Scopes**, add exactly one scope:

   ```
   https://www.googleapis.com/auth/gmail.readonly
   ```

   This is read-only. The app cannot send, delete, or modify your mail. Do not add
   `gmail.send` or `gmail.modify`.
5. Click **Publish / Continue**. You do *not* need to submit the app for verification to
   analyse your own mailbox — see the next point.

> **External app + "Testing" mode:** while the app is in Testing, only accounts you list
> as **Test users** can authorise it. Add your own Google account under
> **OAuth consent screen > Test users**, otherwise you will hit `403 access_denied`.

### 3.4 Create the OAuth client

1. Go to **APIs & Services > Credentials**.
2. Click **Create credentials > OAuth client ID**.
3. Application type: **Web application**.
4. Name it `Personal Attention Engine (local)`.
5. Under **Authorized redirect URIs** add **exactly**:

   ```
   http://localhost:8787/api/auth/google/callback
   ```

   The port must match `PORT` in your `.env`. This URL must match character for
   character, including the `http://` (not `https://`) on localhost.

6. Click **Create**, then **Download JSON** (or copy the client id / secret).

### 3.5 Give the credentials to the app — locally only

Two options, both fine. Never paste these values into a chat, a commit, or a URL.

**Option A — file (recommended).** Save the downloaded JSON as `credentials.json` in the
project root. `.gitignore` already excludes it. Leave `GOOGLE_CREDENTIALS_PATH` blank and
the app finds `credentials.json` automatically. You can also point at it explicitly:

```env
GOOGLE_CREDENTIALS_PATH=./credentials.json
```

**Option B — environment variables.** Leave `credentials.json` absent and set:

```env
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxx
```

**What a client secret is, in plain terms:** it identifies *your local application* to
Google. It is not your Google password, it does not grant access to your account, and
`gmail.readonly` still requires you to personally click "Allow" on Google's consent
screen. It lives only on your machine, in `.env`, and is read only by the backend.

### 3.6 Connect

1. `npm run dev`
2. Open <http://localhost:5173>.
3. Click **Connect Gmail** → **Continue with Google**.
4. Choose your account, review the permissions (read-only), click **Allow**.
5. You land back on the app showing **Connected**.
6. Click **Analyze recent email**.

The first run analyses `ANALYSIS_MESSAGE_LIMIT` messages (default 100). On a typical
mailbox that is a few seconds of rule-based work plus a handful of AI calls.

---

## 4. What each piece does

| Path | Purpose |
| --- | --- |
| `server/src/config` | Typed, validated environment loading |
| `server/src/db` | SQLite schema + repositories (node:sqlite, no native build) |
| `server/src/mail` | Gmail OAuth, message fetch, MIME parsing, threading |
| `server/src/attention` | The attention engine — all the decision logic |
| `server/src/ai` | `AIProvider` interface + deterministic & OpenAI-compatible impls |
| `server/src/api` | Express routes, SSE stream, error handling |
| `server/src/pipeline` | Orchestrates fetch → parse → analyse → persist → notify |
| `server/src/assistant` | Scoped Q&A over your attention items |
| `server/src/notifications` | Notification abstraction + browser delivery |
| `server/tests` | Automated tests + 12 fixtures + an end-to-end check |

### The engine, in six stages

1. **Normalize** — MIME to a trusted `NormalizedEmail`. Malformed input degrades, never throws.
2. **Prefilter** — cheap structural rules for noise. Most mail stops here and never reaches a model.
3. **Thread** — group by thread; the newest message is the live state of the situation.
4. **Signals** — typed evidence: action, obligation, deadline, urgency, consequence, resolution.
5. **Resolve** — suppress anything already handled, withdrawn, or past its deadline.
6. **Merge** — combine rules with the AI, score priority, calibrate confidence, dedupe.

Stages 1–5 are deterministic and fully tested. The AI is an optional refinement on top.

`ARCHITECTURE.md` has the diagrams, `PRODUCT_SPEC.md` the rules, `SECURITY.md` the threat
model.

---

## 5. Environment variables

Everything is optional; the app boots with none of it set. See `.env.example` for
comments. The ones that matter:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Backend port |
| `WEB_APP_URL` | `http://localhost:5173` | Where Google should send you back to |
| `SESSION_SECRET` | random per boot | Signs the OAuth state cookie |
| `GOOGLE_CREDENTIALS_PATH` | auto | Path to Google client JSON |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Credentials instead of a file |
| `AI_API_KEY` | – | Leave blank to use the deterministic analyzer |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `AI_MODEL` | `gpt-4o-mini` | Model id |
| `AI_MODE` | `hybrid` | `off` \| `hybrid` \| `ai` |
| `ANALYSIS_MESSAGE_LIMIT` | `100` | Recent messages per run |
| `ATTENTION_MIN_CONFIDENCE` | `0.55` | Feed threshold |
| `NOTIFY_MODE` | `high` | `off` \| `high` \| `all` |
| `DATA_DIR` | `./data` | SQLite location, relative to the repo root |
| `AI_TIMEOUT_MS` | `25000` | Give up on a slow model, use the rules |
| `BODY_EXCERPT_CHARS` | `600` | Email characters stored locally per message |
| `AI_EXCERPT_CHARS` | `900` | Email characters sent to the AI provider |
| `GMAIL_QUERY` | see `.env.example` | Which messages to fetch |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

`CACHE_TTL_DAYS`, `BODY_EXCERPT_CHARS`, `AI_EXCERPT_CHARS`, `GMAIL_QUERY`, and `LOG_LEVEL`
exist for tuning; leave them alone unless you have a reason.

---

## 6. HTTP API

The backend is the only thing that talks to Gmail. Nothing here requires a secret to
call, except the OAuth start and callback.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, Gmail connection state, last run summary |
| `GET` | `/api/config` | Non-secret configuration: AI mode and model, thresholds |
| `GET` | `/api/auth/status` | `{ configured, connected, email }` — never any token |
| `GET` | `/api/auth/google` | Redirects to Google's consent screen |
| `GET` | `/api/auth/google/callback` | OAuth redirect target set in Google Cloud |
| `POST` | `/api/auth/disconnect` | Wipes local tokens |
| `POST` | `/api/analyze` | Runs the pipeline. Body: `{ limit?, demo? }` |
| `GET` | `/api/attention?status=open\|all` | The feed, plus counts per status |
| `GET` | `/api/attention/:id` | One item with its event history |
| `GET` | `/api/attention/:id/source` | Plain-text excerpt of the source email |
| `POST` | `/api/attention/:id/handled` | Marks handled |
| `POST` | `/api/attention/:id/dismiss` | Hides it from the feed |
| `POST` | `/api/attention/:id/reopen` | Returns it to the feed |
| `POST` | `/api/ask` | Scoped Q&A. Body: `{ question }` |
| `GET` | `/api/stream` | Server-Sent Events, used for notifications |
| `GET` | `/api/debug/suppressed` | Audit trail: what was filtered out, and why |

Errors are always `{ error: { code, message, hint } }` with an appropriate status.
The `hint` is written for the person using the app, not for a developer reading a
stack trace.

---

## 7. Tests

```bash
npm test         # 279 automated tests
npm run typecheck
npm run e2e      # end-to-end against the production build
npm run seed     # print the engine's verdict on the fixtures, no browser needed
npm run seed:reset  # same, after clearing existing items
```

| Suite | Covers |
| --- | --- |
| `parser.test.ts` | MIME, RFC 2047, quoted-printable, HTML→text, header decoding |
| `fixtures.test.ts` | The engine on real emails: categories, deadlines, threads, dedupe |
| `ai.test.ts` | Model output validation, hostile payloads, PII redaction |
| `aiProvider.test.ts` | Provider success, malformed output, 401/429/500, timeouts |
| `gmail.test.ts` | OAuth, token refresh, quota errors, pagination, normalisation |
| `db.test.ts` | Real SQLite: constraints, upserts, ordering, transactions |
| `pipeline.test.ts` | Fetch → analyse → persist: thread hydration, dedupe, suppression audit |
| `api.test.ts` | Every endpoint, status codes, error shapes, rate limiting |
| `security.test.ts` | The `SECURITY.md` checklist, enforced as assertions |

Three of these deserve calling out, because they are the ones that would otherwise
be quietly wrong:

- **Anti-slop.** A mostly-noise corpus is asserted to produce few or no items, and no
  item may ever carry a non-actionable category.
- **AI degradation.** Garbage, empty, oversized, and hostile model output must all fall
  back to the deterministic result rather than crash or surface nonsense.
- **Secret and scope checks.** No key-shaped literals in source, no `dangerouslySetInnerHTML`,
  no SQL built by interpolation, and `gmail.readonly` as the only scope requested — with no
  configuration that can add another.
- **Thread hydration.** A partial thread (what `-is:sent` produces) must still be resolved,
  must not duplicate messages, and must not fail the run if the thread fetch does.
- **Demo date shifting.** The demo shifts fixtures to "now"; the security alert must stay
  live and the expired-deadline fixture must stay expired, both checked against the real clock.

`npm run e2e` starts the real server against the production bundle and checks the
whole path: static assets, SPA routing, security headers, a full analysis, item
lifecycle, the assistant, SSE, and rate limiting. Run `npm run build` first.

---

## 8. Troubleshooting

**"Gmail is not configured"**
No credentials found. Put `credentials.json` in the project root or set
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. See §3.5.

**`redirect_uri_mismatch`**
The redirect URI in Google Cloud Console does not match the one Google sent. It must be
`http://localhost:<PORT>/api/auth/google/callback` with the same `PORT`. Copy it from the
console rather than typing it.

**`403 access_denied` during consent**
The app is External and in Testing mode, and your account is not a test user. Add it under
**OAuth consent screen > Test users**, then try again.

**`Access blocked: has not completed verification` / app unverified**
Expected for External apps in Testing, and normally harmless for your own account — but
you must be a listed test user. If it persists, add yourself as a test user and retry, or
switch the consent screen back to Testing.

**Signed in but "Session expired"**
OAuth `state` cookies are `SameSite=Lax` and live on `localhost:8787`, while the UI is on
`localhost:5173`. If `WEB_APP_URL` points somewhere else, cookies will not survive the
round trip. Set `WEB_APP_URL` to the exact origin you open the UI from.

**"AI analysis is temporarily unavailable"**
`AI_MODE=ai` with no working provider. Set `AI_MODE=hybrid` (or `off`) and the deterministic
analyzer takes over. Nothing crashes.

**"Your Gmail token was rejected"**
Refresh token revoked (you changed your Google password, or you used "Remove access").
Click **Disconnect**, then connect again.

**Analysis finds nothing**
Expected on a quiet inbox, and a designed outcome. Lower `ATTENTION_MIN_CONFIDENCE` to
`0.4` in `.env` if you want to see borderline items while tuning.

**Port already in use**
`PORT=8788 npm run dev` and update the Authorized redirect URI in Google Cloud to
`http://localhost:8788/api/auth/google/callback`.

**Vite proxy errors**
The backend is not running. Start `npm run dev` (both processes) rather than
`npm run dev:web` alone.

---

## 9. Known limitations

Honest list; extended discussion in `SECURITY.md`.

- **Single user, local only.** No accounts, no multi-tenancy, no deployment story.
- **Read-only Gmail.** The app can never archive or reply. That is deliberate.
- **Deadlines are best-effort.** Natural-language dates ("by next Friday") are parsed by
  rules; genuinely ambiguous phrasing is shown as `No deadline detected` rather than
  guessed.
- **No NLP model.** The deterministic analyzer is strong on structure (headers, threads,
  deadlines, question marks, action verbs) and weaker on nuance. An AI provider improves
  the wording, not the architecture.
- **Email bodies are not persisted.** Re-opening a source item reads it from Gmail, so
  that requires a live connection.
- **Notifications need the tab open.** Browser notifications are delivered over SSE while
  the app is running. A closed tab means no notification.
- **Inbox only.** No search across all mail, no attachments, no calendar, no drafts.
