# Security

Email is among the most sensitive data a person produces: it reveals health, finances,
family, legal matters, employment, and location. This document states what the app does
to protect it, what it cannot protect against, and what a reviewer should verify.

## 1. Trust model

| Party | Trust | Why |
| --- | --- | --- |
| Google Gmail API | High | Authenticated directly with OAuth, TLS |
| Local filesystem | High | User's own machine |
| `.env` / `credentials.json` | High | Never leaves the machine, never committed |
| AI provider | **Partially trusted** | Receives *minimized* email content, retains per its own policy |
| Email senders | **Untrusted** | Input that must never be executed or trusted as HTML |

The last row is the one that generates most real risk, because attackers control email
content.

## 2. Data flow and minimisation

```
Gmail ──TLS──> backend ──(only if AI enabled, and only for candidates)──> AI provider
                 │
                 ├──> SQLite (excerpt only, capped 600 chars; never full bodies)
                 └──> browser (JSON fields only; never raw MIME, never tokens)
```

**The AI provider only ever receives:** sender name + domain, subject, a bounded body
excerpt (default 600 characters), timestamps, thread shape, and extracted signals. It does
not receive the Gmail account address, message IDs, thread IDs, or attachments. See
`server/src/ai/redact.ts`.

If `AI_MODE=off`, no email content leaves the machine at all. This is the strongest
configuration and is fully functional.

## 3. Controls implemented

### 3.1 Secrets

- No secret is ever hard-coded. All configuration is environment-based with typed
  validation in `server/src/config/env.ts`.
- `.gitignore` excludes `.env`, `.env.*`, `credentials.json`, `client_secret*.json`,
  `token.json`, and `data/`. Verified in CI by `git check-ignore`.
- Tokens are stored server-side in SQLite and are **never** returned by any API endpoint.
  `/api/auth/status` returns booleans and the email address only.
- `SESSION_SECRET` is generated randomly per boot if unset, so a missing secret degrades
  to session churn rather than a hard failure.
- No secret is logged. `server/src/logging/logger.ts` redacts known-sensitive keys and
  scrubs anything that looks like a token before writing.

### 3.2 OAuth

- **Scope is `https://www.googleapis.com/auth/gmail.readonly` only.** The app cannot send,
  delete, modify, or label mail. This is the single most important control here: a bug in
  the rest of the system cannot result in mailbox mutation.
- **The grant cannot be widened by configuration.** There is no environment variable that
  adds a scope; `scopes()` returns a single-element array. `include_granted_scopes` is
  `false`, so previously granted scopes are not folded back into the request. Widening a
  mail grant must be a deliberate code change, not something a stray `.env` value can do.
  `server/tests/security.test.ts` asserts both.
- `access_type=offline` with `prompt=consent` is used once at authorisation so a refresh
  token exists for background refresh.
- OAuth `state` is a cryptographically random value bound to an `HttpOnly`, `SameSite=Lax`
  cookie and verified on callback. This blocks CSRF against the callback.
- The OAuth **client secret identifies this local application to Google.** It is not the
  user's Google password, and it grants no mailbox access on its own; `gmail.readonly`
  still requires the user to personally approve access. It is stored locally only.
- Access tokens are refreshed on demand; a failed refresh marks the session disconnected
  rather than retrying in a loop.
- Tokens can be wiped from the UI (`POST /api/auth/disconnect`).

### 3.3 Email content is hostile input

- **Raw email HTML is never rendered.** The parser converts HTML to plain text with a
  strict allowlist of block-level break tags and decodes entities; everything else is
  stripped. The React frontend renders every email-derived value as text content. There is
  no `dangerouslySetInnerHTML` anywhere in `web/src`, and no `srcDoc`/iframe embedding.
  This removes stored-XSS via a malicious email as a category of bug.
- **No external resource loading.** No tracking pixels, no remote images, no
  `<img onerror>`. HTML conversion is regex/text based and offline.
- Email bodies are never interpolated into SQL. Every database call is a bound
  statement with positional parameters — no string-concatenated SQL anywhere in
  `server/src/db`.
- **AI output is data, never code.** Responses are parsed against a zod schema, fields are
  length-capped, enums are coerced, and `confidence` is clamped to `[0,1]`. Output is
  rendered as text. Nothing from a model is executed, evaluated, or used to build a query.
- Body excerpts are truncated before storage, so the database does not become a shadow
  mailbox.

### 3.4 HTTP surface

- `helmet`-equivalent headers are applied manually in `server/src/api/middleware.ts`:
  `Content-Security-Policy` (no `unsafe-inline` for scripts), `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- CORS is restricted to `WEB_APP_URL` rather than `*`.
- JSON bodies are capped at 256 KB.
- Rate limiting is applied to the analysis and assistant endpoints.
- Errors returned to the client are sanitised `AppError` shapes. Stack traces are logged
  server-side, never serialised.

### 3.5 Logging

Email bodies are **never** logged. Log lines carry message IDs, categories, counts, and
timings. `logger.redact()` additionally strips anything matching a token-shaped pattern as
a defence against accidental leakage by a future code change.

### 3.6 Network

- All outbound requests are HTTPS, to `oauth2.googleapis.com`, `gmail.googleapis.com`, or
  the configured `AI_BASE_URL`. There is no telemetry and no analytics.
- The AI provider is only contacted when `AI_API_KEY` is set. With it unset, zero bytes of
  email content leave the machine.

## 4. Known limitations

Stated plainly, because a security document that claims completeness is not useful.

1. **Local prototype, not hardened for the internet.** No TLS termination, no user
   authentication on the API itself, no CSRF tokens for state-changing endpoints beyond
   `SameSite`. Anyone who can reach `localhost:8787` can use the API. Do not bind it to
   `0.0.0.0` on a shared or public network.
2. **Token storage is not OS-keystore-backed.** The refresh token sits in a SQLite file on
   disk. On a shared machine, another local user or malware with your privileges can read
   it. Mitigations available now: keep the machine locked, use a full-disk-encrypted OS, and
   restrict `data/` permissions. Mitigations *not* implemented: OS keychain, hardware-backed
   sealing.
3. **AI provider retention is out of our control.** If you configure a third-party AI
   provider, that provider's privacy policy and retention terms apply to the excerpt sent.
   For anything sensitive, use `AI_MODE=off` or a self-hosted endpoint such as Ollama.
4. **OAuth client secret is in a plaintext file.** Standard for local Google OAuth desktop/
   web clients, but it is readable by any process running as you.
5. **`gmail.readonly` is broad.** It grants read access to the *entire mailbox*, not just
   recent mail. The app only requests recent messages, but the grant itself is
   all-or-nothing. There is no narrower Gmail scope.
6. **No encryption at rest for the SQLite database.** Excerpts are plaintext. See (2).
7. **No audit log of security-relevant events.** Access tokens are not logged for good
   reason, which also means an incident cannot be reconstructed.
8. **Prompt injection is mitigated, not solved.** A hostile email can attempt to instruct
   the model. Mitigations: the model is given a strict output schema, receives email
   content as clearly delimited untrusted data, cannot call tools or take actions, and its
   output is validated and rendered as inert text. But a sufficiently adversarial email
   could still skew *wording*. It cannot cause an action, because the model has no
   capability to take one.

## 5. Reviewer checklist

- [ ] `git check-ignore -v credentials.json .env data/attention.db` → all ignored
- [ ] `grep -rn "dangerouslySetInnerHTML" web/src` → no matches
- [ ] `grep -rn "sk-\|AIza" --include=*.ts server/src` → no keys
- [ ] `grep -rni "scope" server/src/mail` → only `gmail.readonly`
- [ ] `grep -rn "include_granted_scopes" server/src/mail` → `false`
- [ ] No `SELECT`/`INSERT` built by string concatenation in `server/src/db`
- [ ] `/api/auth/status` response contains no token material
- [ ] Log output of a full analysis run contains no email body text

## 6. Reporting a vulnerability

This is a local prototype with no published disclosure process. If you find something
that matters, report it privately to the maintainer rather than opening a public issue
containing exploit detail.
