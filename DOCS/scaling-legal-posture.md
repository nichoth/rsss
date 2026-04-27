# Scaling the legal posture

Notes for moving from "alpha hobby ToS/Privacy" to "real paid SaaS".
The current `/terms` and `/privacy` pages are good for taking small
payments as an individual. They are **not** good for running a real
subscription business. The gap is real but bridgeable.

Most of what changes is the legal posture *behind* the text. The text
changes only matter if the underlying setup is right.

---

## 1. Things to do outside the codebase first

These are independent of the pages, but the pages reference them or are
useless without them.

### Form an LLC (Washington)

The current Terms says "operated by an individual... not a company." At
scale that means *you personally* are on the hook for every claim. A
single-member Washington LLC takes a few hours and around $200; it puts
a corporate veil between your house and an angry user. Once it exists,
swap the "Operator" language to name it.

### Register a DMCA designated agent

$6, online, public registry with the U.S. Copyright Office. RSSS caches
feed content. Without a registered agent you don't get DMCA section 512
safe harbor, meaning a single C&D over a copyrighted feed item can
become *your* problem instead of the publisher's. The Terms should then
have a "Copyright complaints" section pointing at the agent. The
registration must be kept current (renewal every three years).

### Sales tax registration

Washington taxes SaaS as a "digital automated service" in many
configurations. Autumn / Stripe Tax usually handles collection if you
turn it on, but you need to register with WA DOR. The Terms should
disclose that prices exclude tax.

### Auto-renewal disclosure compliance

California (and now around 10 other states) require very specific
opt-in language and cancellation methods for auto-renewing
subscriptions. This is the single most-litigated thing in the SaaS ToS
world right now.

- Needs its own section in Terms.
- The *checkout flow* needs to show the renewal terms before the user
  pays.
- Cancellation must be at least as easy as signup (some states require
  a single click).

---

## 2. Changes to `terms.ts`

### Mandatory arbitration + class-action waiver

The single highest-EV clause in a paid-SaaS ToS. It's what stops $5/mo
getting turned into a $5M class action over a bug. Standard pattern:

- AAA or JAMS rules.
- 30-day opt-out window (required by many courts to be enforceable).
- Carve-outs for small-claims court and IP claims.
- Individual basis only; no class arbitration.

### Liability cap

Keep "12 months of fees paid" but drop the "or US$50" floor (raise to
US$100 or fees-paid, whichever is greater). At scale the $50 floor is
implausibly low and a court may strike it.

### Refund / cancellation policy

Currently we say "described at point of purchase." That is too vague
once there are real subscribers. State the policy explicitly: pro-rated
or no, refund window if any, how to cancel.

### Notice period for material changes

Currently zero. With paying users, 30 days' notice for adverse changes
is standard, and several states require it.

### Export-controls and sanctions clause

Boilerplate. Required for US commercial operators. "You may not use the
Service if you are located in, or are a national or resident of, a
country subject to US embargo, or on any US government denied-party
list."

---

## 3. Changes to `privacy.ts`

### CCPA / CPRA section

California residents have enumerated rights and you must list them,
plus a "Notice at Collection" and a statement about whether you sell or
share PI (you don't, but you have to *say* you don't, in those exact
statutory terms). A "Do Not Sell or Share" link in the footer is
required even if it just says "we don't."

### GDPR section (if accepting EU users)

- Lawful basis per category (Article 6).
- Retention periods.
- Standard Contractual Clauses for international transfers (Schrems II).
- 72-hour breach notification commitment.
- Named controller (your LLC).
- Right to data portability, erasure, rectification with response
  timelines.

### Categories of personal information

In CCPA's statutory taxonomy: identifiers, commercial info, internet
activity, etc. Not just a plain-language list.

### Specific retention periods

Currently vague. CCPA and GDPR both want concrete numbers, or at least
specific criteria for determining them.

### Sub-processor list with DPAs

Cloudflare, Stripe, Autumn, Resend all publish standard Data Processing
Agreements. You need to sign / accept them and reference them in the
policy. This is required to lawfully transfer EU personal data to those
processors.

---

## 4. Recommended sequence

Don't try to make the *text* "scale-ready" before the underlying setup.
The honest sequence:

### Now

- Form the LLC.
- Register the DMCA agent.
- Set up WA sales tax.

These are mechanical and cheap. None of them requires a lawyer.

### Before first paid signup

- Rewrite Terms with the LLC named, arbitration clause, refund and
  auto-renewal disclosure, change-notice period.
- Rewrite Privacy with CCPA/CPRA section, specific retention periods,
  sub-processor list.
- Have a lawyer spend 1-2 hours on it. Washington has plenty who do
  flat-fee SaaS ToS reviews for $500-$1500. At paid-SaaS scale this
  pays for itself the first time someone threatens to sue.

### Before EU launch

- Add GDPR section.
- Sign DPAs with subprocessors.
- Decide on a transfer mechanism (SCCs are the default).

---

## 5. Operational items that aren't text

For completeness, things that aren't in the policies but become
important at scale:

- **EIN** (federal tax ID for the LLC).
- **Washington State business license.**
- **E&O / cyber liability insurance** once revenue justifies it.
- **A real privacy/security incident plan.** Even a one-page runbook is
  better than nothing.
- **Records of processing activities (RoPA)** if GDPR applies.
- **Cookie banner** if EU users and any non-strictly-necessary cookies
  exist (currently we only set the `session` cookie, which is
  strictly-necessary, so we are probably fine without one for now).
