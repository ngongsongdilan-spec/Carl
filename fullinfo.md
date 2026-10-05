
You are the lead engineer responsible for building a working MVP called "Personal Attention Engine".

You are operating inside OpenCode in a local development environment. You have access to the repository and terminal. Do not just describe what should be built. Inspect the repository, make the implementation, run it, test it, debug it, and leave the project in a runnable state.

==================================================

1. PRODUCT
   ==================================================

Build a personal AI attention assistant.

The problem:

People receive many emails, but only a small number actually require their attention.

The product should determine:

1. What happened?
2. Does it actually matter?
3. Why does it matter?
4. Does the user need to do something?
5. What should the user do?
6. Is there a deadline or time-sensitive element?

The product is NOT:

- another generic chatbot
- another Gmail clone
- a generic "Jarvis"
- an email summarizer that summarizes everything
- a marketing/newsletter reader

The core product is an ATTENTION ENGINE.

Its job is to identify genuinely important/actionable information and explain why the user should care.

==================================================
2. MVP SCOPE
============

Keep the MVP intentionally small.

The first version should contain:

A. Google OAuth
B. Gmail integration
C. Email retrieval
D. Email/thread analysis
E. Importance/actionability detection
F. Attention-item generation
G. Clean web interface
H. Source-email access
I. Basic notifications
J. Basic local persistence
K. Tests and documentation

Do NOT build these unless they are necessary for the core MVP:

- Calendar integration
- WhatsApp
- Telegram
- Smart home
- browser automation
- computer control
- payments
- subscriptions
- social media
- mobile app
- multi-user SaaS infrastructure
- autonomous computer agent
- complicated microservices
- Kubernetes
- cloud deployment
- paid notification infrastructure
- paid voice API

The architecture should make those features possible later without building them now.

==================================================
3. CORE USER EXPERIENCE
=======================

The user connects their Gmail account.

The application analyzes recent email.

Instead of showing everything, it creates an "Attention" feed.

Example:

IMPORTANT

"Your domain provider is requesting identity verification."

Why it matters:
"Completing verification may be required to keep your domain account active."

Action:
"Review the verification request."

Deadline:
"If detected from the email, display it. Otherwise say no deadline detected."

Source:
"Open original email"

Another example:

IMPORTANT

"Your university changed the project presentation date."

Why it matters:
"The presentation date changed and may affect your schedule."

Action:
"Review the updated presentation details."

Another example:

NOT IMPORTANT

"Weekly newsletter from XYZ."

This should NOT generate an attention item.

==================================================
4. ATTENTION ENGINE
===================

This is the most important part of the application.

Do NOT simply classify emails as:

important / not important.

Create a richer internal representation.

Each analyzed message should conceptually produce something like:

{
  "is_attention_item": true,
  "priority": "high",
  "category": "account_action",
  "title": "Domain verification required",
  "summary": "Your domain provider is requesting identity verification.",
  "why_it_matters": "Failure to complete verification may affect the account.",
  "recommended_action": "Review and complete the verification request.",
  "deadline": null,
  "confidence": 0.91,
  "source_email_id": "...",
  "source_thread_id": "..."
}

The exact implementation is your decision.

The system should identify categories such as:

- deadline
- account/security
- verification
- payment requiring action
- appointment
- academic/work requirement
- requested response
- important personal communication
- service interruption
- expiring item
- delivery requiring action
- administrative requirement
- other actionable event

It should also recognize:

- newsletters
- advertisements
- promotions
- ordinary receipts
- routine notifications
- informational messages
- spam

as generally non-actionable.

Do not hard-code importance solely based on keywords.

Use context.

==================================================
5. CONTEXT
==========

A major purpose of this product is CONTEXT.

If multiple emails belong to the same Gmail thread, analyze them together when appropriate.

The system should consider:

- sender
- subject
- thread
- message body
- timestamps
- previous messages in the thread
- whether the sender is requesting an action
- whether the email contains a deadline
- whether the situation appears resolved already

For example:

Email 1:
"Please verify your account."

Email 2:
"Thanks, your verification is complete."

The system should NOT continue showing the first email as an unresolved attention item.

Avoid duplicate attention items for the same underlying event.

==================================================
6. IMPORTANCE LOGIC
===================

Use a layered approach.

Prefer deterministic/rule-based processing where appropriate.

Then use AI for semantic understanding.

Do NOT unnecessarily send every email to an expensive AI model.

Design the system so that:

1. obvious low-value emails can be filtered cheaply
2. potentially important emails receive deeper analysis
3. the AI produces structured output
4. invalid AI output is handled safely
5. uncertain results can be marked with lower confidence

Create a clean abstraction around the AI provider.

For example:

AIProvider
  -> analyzeEmail()
  -> analyzeThread()

Do not hard-code the entire application around one AI provider.

The provider should be replaceable later.

==================================================
7. AI API / MODEL CONFIGURATION
===============================

The user may provide an AI API key later.

Never hard-code API keys.

Use environment variables.

Create:

.env.example

and document required variables.

For example:

AI_API_KEY=
AI_BASE_URL=
AI_MODEL=

Use whatever provider/API is most appropriate for the implementation environment.

If no AI API is available during initial development, implement a deterministic fallback/mock analyzer so the application can still be run and tested.

Do not block the entire project waiting for an AI API key.

==================================================
8. GMAIL
========

Use the official Gmail API.

Use Google OAuth 2.0.

The user will personally create the Google Cloud project and provide OAuth credentials locally.

DO NOT ask the user for:

- Gmail password
- Google password
- 2FA code
- recovery code

The application should use OAuth.

Expected scope for reading email:

https://www.googleapis.com/auth/gmail.readonly

Do not request broader Gmail permissions unless genuinely required.

The application should support credentials being supplied locally.

Prefer a secure configuration such as:

credentials.json

and/or environment variables, depending on Google's recommended flow for the selected application architecture.

Never commit credentials to Git.

Add appropriate entries to .gitignore.

==================================================
9. GOOGLE OAUTH UX
==================

The UI should have a clear initial state:

"Connect Gmail"

Then:

"Continue with Google"

After authorization:

"Connected"

Then the user can:

"Analyze recent email"

For development, it is acceptable to analyze a limited number of recent messages rather than the entire mailbox.

Do not scan millions of messages.

Start with a reasonable configurable limit such as:

50 or 100 recent messages.

Make the limit configurable.

==================================================
10. SECURITY
============

Treat email as sensitive data.

Requirements:

- Never log email bodies unnecessarily.
- Never log OAuth tokens.
- Never expose secrets to frontend JavaScript.
- Never commit credentials.
- Sanitize/display email content safely.
- Avoid rendering arbitrary email HTML directly.
- Use environment variables for secrets.
- Keep OAuth tokens protected.
- Minimize requested Google scopes.
- Clearly separate server-side credentials from client-side code.

Create a SECURITY.md explaining the security considerations and known limitations.

This is a prototype, but do not deliberately introduce insecure shortcuts.

==================================================
11. DATABASE / STORAGE
======================

Use a simple local persistence layer appropriate for an MVP.

SQLite is acceptable unless the existing repository strongly suggests another choice.

Persist enough information to avoid repeatedly analyzing the same email.

Possible entities:

User
Email
Thread
AttentionItem
Analysis

Do not over-engineer the schema.

Store only what is necessary.

Avoid storing full email bodies permanently unless required.

Use Gmail message IDs/thread IDs to reference source messages.

==================================================
12. WEB INTERFACE
=================

Build a clean, modern interface.

The UI should feel like a serious product, not an admin dashboard.

Primary screen:

ATTENTION

Show cards/items such as:

---

HIGH PRIORITY

Domain verification required

Your domain provider is requesting
identity verification.

Why it matters:
Your account may be affected if
the verification is not completed.

ACTION
Review verification

[Open email]
------------

Each attention item should show:

- priority
- title
- short explanation
- why it matters
- recommended action
- deadline if known
- confidence if appropriate
- source email
- timestamp

Allow the user to:

- open the original Gmail message
- dismiss an item
- mark as handled
- refresh/analyze new mail

Have a separate low-noise state:

"No important items right now."

Do not fill the interface with unnecessary charts, statistics, animations, or AI decorations.

==================================================
13. NOTIFICATIONS
=================

Implement basic local/browser notifications if practical for the chosen architecture.

Only notify when:

- a genuinely important new item is detected
- the item is not already handled
- the item has not already been notified

Do not notify for every analyzed email.

Create a notification abstraction so it can later be replaced by:

- Android notifications
- push notifications
- desktop notifications

For the MVP, keep it simple.

==================================================
14. "WHAT'S IMPORTANT?" INTERACTION
===================================

Include a simple way for the user to ask:

"What needs my attention?"

The application should return the current unresolved attention items.

If an AI chat interface is used, keep it tightly scoped.

Do NOT turn this into a general-purpose chatbot.

The assistant should primarily answer questions about the user's detected attention items and email context.

Examples:

"What needs my attention?"

"What is the most urgent thing?"

"Why is this important?"

"What do I need to do?"

"Show me the email this came from."

==================================================
15. ARCHITECTURE
================

Choose a sensible architecture based on the repository.

Favor simplicity.

A reasonable architecture might be:

Frontend
   |
Backend API
   |
----

| Gmail Service               |
| Attention Engine             |
| AI Provider                  |
| Notification Service         |
| Persistence                  |
--------------------------------

Keep clear interfaces between components.

The AI provider should be replaceable.

The Gmail integration should be replaceable.

The notification system should be replaceable.

Do not create unnecessary microservices.

==================================================
16. DOCUMENTATION
=================

Before implementation, create/update:

README.md

ARCHITECTURE.md

PRODUCT_SPEC.md

SECURITY.md

.env.example

The README must explain exactly how a developer can run the application locally.

Include:

1. prerequisites
2. installation
3. environment variables
4. Google Cloud setup
5. Gmail API setup
6. OAuth configuration
7. running the backend
8. running the frontend
9. connecting Gmail
10. running tests
11. troubleshooting

Assume the person following the README is a beginner/intermediate developer.

Do not assume undocumented configuration.

==================================================
17. GOOGLE CREDENTIALS
======================

The user will provide Google OAuth credentials separately.

If credentials are missing:

DO NOT invent credentials.

DO NOT fabricate client IDs.

DO NOT ask for the user's password.

Instead:

1. implement the integration
2. create clear documentation
3. tell the user exactly which file/environment variable is required
4. allow the application to start without credentials if practical
5. provide a clear error when Gmail functionality is attempted without credentials

==================================================
18. TEST DATA
=============

Create a way to test the attention engine without Gmail.

Create fixtures containing examples such as:

1. Important security email
2. Domain verification
3. University deadline
4. Meeting request
5. Promotional newsletter
6. Advertisement
7. Ordinary receipt
8. Password/security alert
9. Resolved request
10. Deadline that has passed
11. Email thread containing multiple messages
12. Informational announcement

Tests should verify that the system does not simply classify everything as important.

==================================================
19. TESTING
===========

Write automated tests for:

- email parsing
- importance detection
- action extraction
- deadline extraction
- duplicate detection
- resolved-thread handling
- confidence handling
- AI response validation
- Gmail service
- API endpoints
- database operations

At minimum, test the core Attention Engine thoroughly.

Also perform an actual end-to-end manual test if Google credentials are available.

Do not claim a feature works unless you actually tested it.

==================================================
20. ERROR HANDLING
==================

Handle:

- invalid OAuth credentials
- expired OAuth token
- Gmail API failure
- rate limits
- malformed email
- empty inbox
- AI provider failure
- invalid AI response
- database failure
- notification failure

The application should degrade gracefully.

For example:

If AI is unavailable:

"AI analysis is temporarily unavailable."

Do not crash the entire application.

==================================================
21. PERFORMANCE
===============

Do not analyze the entire inbox by default.

Use:

- pagination
- configurable message limits
- caching
- deduplication
- database persistence

Avoid repeatedly processing the same messages.

==================================================
22. FUTURE ARCHITECTURE
=======================

Do not implement these now, but make the architecture capable of adding:

Gmail
Calendar
Files
Web Search
Browser
Voice
Android
Reminders
More email providers

The long-term concept is:

Information
    ↓
Context
    ↓
Attention
    ↓
Recommended Action
    ↓
User confirmation
    ↓
Action

But the MVP ends around:

Information
    ↓
Context
    ↓
Attention
    ↓
Recommended Action

Do not build the entire future product now.

==================================================
23. PRODUCT PRINCIPLE
=====================

The most important product rule:

THE SYSTEM MUST OPTIMIZE FOR SIGNAL, NOT ACTIVITY.

Do not try to show the user that the AI processed 100 emails.

The goal is to correctly identify the 1–5 things that genuinely deserve attention.

A quiet inbox should be allowed to produce:

"No important items right now."

That is a successful result.

==================================================
24. DEVELOPMENT PROCESS
=======================

Follow this process:

STEP 1
Inspect the existing repository.

STEP 2
Determine the existing stack.

STEP 3
If the repository is empty, choose a simple modern stack appropriate for a local full-stack MVP.

STEP 4
Create PRODUCT_SPEC.md and ARCHITECTURE.md before substantial implementation.

STEP 5
Implement the smallest working vertical slice:

Google OAuth
→ Gmail
→ fetch recent messages
→ analyze
→ attention item
→ display

STEP 6
Run it.

STEP 7
Fix errors.

STEP 8
Add persistence.

STEP 9
Add tests.

STEP 10
Add notifications.

STEP 11
Improve UI.

STEP 12
Perform an end-to-end test.

Do not spend excessive time polishing the UI before the core workflow works.

==================================================
25. AGENT BEHAVIOR
==================

You are expected to operate autonomously.

Do not repeatedly ask me to make trivial technical decisions.

If there are multiple reasonable choices, choose one and continue.

Ask me only when you genuinely require information or credentials that only I can provide.

When you need credentials, NEVER ask me to paste secret values into chat.

Tell me exactly:

- what credential is required
- where I obtain it
- where I should place it locally
- what environment variable/file should contain it

Then continue once it is available.

Do not stop after creating a plan.

Actually build the application.

Run commands.

Run tests.

Inspect errors.

Fix them.

==================================================
26. DEFINITION OF DONE
======================

The MVP is considered complete only when:

[ ] Application starts locally
[ ] User can connect Gmail through Google OAuth
[ ] Gmail messages can be retrieved
[ ] Recent messages can be analyzed
[ ] Attention items are generated
[ ] Important vs ordinary email is reasonably distinguished
[ ] Thread context is considered
[ ] Duplicate attention items are avoided
[ ] Attention items explain WHY they matter
[ ] Recommended actions are shown
[ ] Source email can be opened
[ ] Items can be dismissed/marked handled
[ ] New important items can trigger a basic notification
[ ] AI provider can be configured without hard-coding secrets
[ ] Credentials are excluded from Git
[ ] Test fixtures exist
[ ] Automated tests pass
[ ] README is complete
[ ] Security documentation exists
[ ] The application has been manually tested
[ ] No fake/mock feature is presented as working functionality

==================================================
27. FINAL REPORT
================

When you have finished, provide a concise report containing:

1. What you built
2. Architecture
3. Files created/modified
4. Technologies used
5. Features that actually work
6. Tests performed and results
7. Credentials/configuration I still need to provide
8. Exact commands I need to run
9. Known limitations
10. What you recommend building next

Most importantly:

BUILD THE PRODUCT.

Do not merely return code snippets or a theoretical architecture.
