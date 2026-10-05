# Product Spec

## 1. The problem

A person's inbox receives hundreds of messages. A handful require a decision. The rest
are ambient. The gap between *arrival* and *obligation* is where attention is wasted.

This product closes that gap for email.

## 2. The one rule

> **Optimise for signal, not activity.**

Consequences, treated as binding requirements rather than aspirations:

- Never show a count of how many emails were processed. That is the system's job.
- Never display an item the user could not act on or could not understand the stakes of.
- Never be afraid to show nothing. **"No important items right now."** is a first-class,
  well-designed state.
- Never trade precision for recall to make the feed look busy. Five well-explained items
  beat twenty vague ones.

## 3. What an attention item is

```ts
{
  id: string;
  is_attention_item: true;
  priority: 'high' | 'medium' | 'low';
  category: AttentionCategory;
  title: string;             // "Domain verification required"
  summary: string;           // what happened, one or two sentences
  why_it_matters: string;    // the consequence of ignoring it
  recommended_action: string;// the next concrete step
  deadline: { iso: string; raw: string; kind: string } | null;
  confidence: number;        // 0..1
  source_email_id: string;
  source_thread_id: string;
  status: 'open' | 'handled' | 'dismissed' | 'resolved';
  created_at: string;
}
```

Every field is user-facing. `confidence` is shown only when below a comfortable
threshold; a 0.98 item does not need a percentage next to it.

## 4. Categories

Actionable:

| Category | Meaning | Example |
| --- | --- | --- |
| `deadline` | A hard date by which something is due | Submission due Friday |
| `account_security` | Credentials, sign-ins, suspicious activity | New device sign-in |
| `verification` | Identity/domain/account proof required | Domain registrant check |
| `payment_action` | Money owed, failed, or requiring authorisation | Card charge failed |
| `appointment` | A scheduled time the user must attend | Clinic appointment moved |
| `requirement` | Academic, work, or administrative obligation | Project date changed |
| `requested_response` | Someone is waiting for a reply | Interview scheduling question |
| `personal` | Important direct human communication | Family, close collaborator |
| `service_interruption` | Something is broken or degraded | Payment service down |
| `expiring_item` | A document, code, or offer is running out | Passport renewal window |
| `delivery_action` | A package needs an action or is stuck | Held at customs |
| `administrative` | Forms, registrations, renewals | Tax filing reminder |

Non-actionable, must not generate items: `newsletter`, `advertisement`, `promotion`,
`receipt`, `routine_notification`, `informational`, `spam`.

## 5. Importance logic

Layered, in this order. Each layer may only *increase* what the layer below found; a
later layer never silently hides a structural fact.

1. **Structural layer** — headers, labels, sender relationship, MIME facts. Free.
2. **Prefilter** — is this provably bulk/promotional? Skip without AI.
3. **Signal layer** — action, obligation, deadline, urgency, consequence, resolution.
4. **Thread layer** — position in thread, prior messages, whether already resolved.
5. **AI layer** — semantics, wording, tone, and category refinement, only where the
   signal layer is ambiguous. Validated, never trusted blindly.
6. **Resolution layer** — suppress anything already handled, completed, or expired.

### Priority

- `high` — an active obligation with a consequence of inaction (deadline, suspension,
  security event, failed payment, required verification).
- `medium` — a real request or change that needs the user to do something, no immediate
  consequence.
- `low` — worth knowing, weak or distant obligation.

### Confidence

Confidence reflects *evidence*, never volume of keywords:

- Structural evidence present (real person, not bulk): floor at 0.5
- Multiple independent signals agreeing: +0.1 each, capped
- Deadline parsed with an explicit date: +0.1
- Rule and AI agree: +0.15 · disagree: −0.2
- Only a single weak keyword: hard cap at 0.45

An item must clear `ATTENTION_MIN_CONFIDENCE` (default 0.55) to reach the feed.

## 6. Thread semantics

The system reasons about *situations*:

- A request followed by its completion is closed, not pending.
- A user reply that says "done / thanks / that worked" closes the request.
- Only the newest relevant message anchors an item; older ones are retained as
  `superseded` for provenance.
- Later context wins: "ignore that, we extended the date" replaces the earlier deadline.

## 7. Duplicate suppression

An `event_key` of `category:normalized-entity:time-bucket` collapses multiple emails about
one event. Thread id participates. A reminder three days after a deadline notice does not
create a second item; it annotates the first.

## 8. User-facing behaviour

| State | Requirement |
| --- | --- |
| Not connected | Single clear **Connect Gmail** action |
| Connected | Shows address, connection state, **Analyze recent email** |
| Analysing | Honest progress ("Fetched 100 · analysed 100"), not fake percentages |
| Attention present | Cards: priority, title, summary, why it matters, action, deadline, source |
| Nothing important | **"No important items right now."** — calm, not apologetic |
| AI unavailable | Banner: AI analysis temporarily unavailable; deterministic results still shown |

Card actions: **Open in Gmail**, **Open source email**, **Mark handled**, **Dismiss**,
**Refresh**.

## 9. Notifications

Notify only when all are true: item is new, `priority` meets `NOTIFY_MODE`, status is
`open`, confidence clears the threshold, and `notified_at` is null. One notification per
item, ever. Failures never block analysis.

## 10. Scoped assistant

The assistant answers questions about *your detected attention items*:
"What needs my attention?" · "What's most urgent?" · "Why is this important?" ·
"What do I need to do?" · "Show me the email this came from."

It must not become a general assistant. Off-topic questions are refused and redirected.
Answers cite the item they came from.

## 11. Non-goals

Calendar, messaging apps, browser automation, payments, social, mobile, multi-user infra,
cloud deployment, autonomous action, voice. The architecture keeps room for them; the MVP
does not build them.

## 12. Definition of done

- [x] App starts locally with and without credentials
- [x] Gmail connects via OAuth, read-only
- [x] Recent messages fetched with a configurable, bounded limit
- [x] Attention items generated with the full field set
- [x] Important vs ordinary clearly distinguished (tested against a mostly-noise corpus)
- [x] Thread context considered, resolved threads closed
- [x] Duplicates suppressed
- [x] Every item explains why it matters
- [x] Recommended actions shown
- [x] Source email openable
- [x] Items dismissible and markable handled
- [x] Notifications fire once per genuinely new important item
- [x] AI provider configurable, secrets never hard-coded, deterministic mode works
- [x] Credentials excluded from Git
- [x] 12 fixtures
- [x] Automated tests pass
- [x] README complete
- [x] SECURITY.md present
- [x] Manually exercised end to end
- [x] No mock presented as working functionality
