# The pitch, and an honest read on whether this is any good

Written 4 Sep 2026 for the AI*thon 4.0 final. Judges: Mohit Mittal and Puneet
Kumar (investors, India Quotient — Lokal's own investor), Siddharth Dialani
(investor, All in Capital; founder, BharatAgri), Dharmesh BA (founder, 1990
Research Labs). Five minutes per team.

---

## Brutally honest: is what we built good, or bleh?

**The engineering is genuinely good. The framing we had was bleh.** Those are
two different problems and only the second one loses.

### What is actually strong

- **It works, live, end to end.** Most hackathon demos are a Figma flow and a
  hardcoded response. This makes a real phone-quality voice call, holds a
  conversation, interrupts and gets interrupted, and produces a graded scorecard
  from what was actually said. Zero stream drops across six consecutive
  full-length runs, 2.6 seconds from connect to her first word.
- **It speaks Hindi.** Not translated subtitles — actual Hindi speech-to-speech
  with English technical terms left in place, which is how people here really
  talk. Verified: 16 of 16 interviewer lines in Devanagari, 92 seconds of real
  speech.
- **The grading discriminates in the right direction, and we can prove it.**
  Same rubric, two candidates: one who says "I don't remember the exact method
  names" and then reasons correctly through a durability trade-off scores
  **Advance 82**. One who fluently says "thundering herd, XFetch,
  at-least-once semantics" but cannot explain why the spike lands at the same
  time daily scores **Advance with focus 62**, flagged "reasoning collapses
  under follow-up". That contrast is the single most demoable thing we have.
- **The fairness engineering is unusually careful** and it is all
  demonstrable: proctoring flags provably cannot move technical scores
  (identical verdict and all six axis scores with and without them), and a call
  the platform broke is labelled as such above the verdict so a recruiter never
  reads a bad connection as a bad candidate.

### What is weak, and judges will smell it

- **"AI interviews our engineering candidates" is a small idea.** Lokal hires a
  few hundred people a year. Saving two engineer-hours per screened candidate
  is real, worth maybe a few hundred hours annually, and completely unexciting
  to an investor. It is an internal tools pitch.
- **AI interviewers are a crowded commodity.** Mercor, Micro1, HireVue,
  CodeSignal, HireSnap at ₹200 a session. Every judge in that room has seen a
  deck like this. "We built one too, but internal" invites the obvious
  question and we lose on it.
- **The org-grounding is our best technical differentiator and the hardest to
  feel.** "Candidates reason about our own postmortems" is a real moat no
  vendor can copy, but it lands with engineers and glazes over with everyone
  else.
- **It is voice-only.** No coding, no work sample. Fine for Round 0, but do not
  oversell what it establishes.
- **Prototype seams.** No auth on admin, no database, no object storage,
  workshop credentials that expire mid-demo. Own these before someone asks.

**Verdict: the build is a strong 8, the internal-HR pitch is a 4.** The fix is
not more engineering. It is pointing the same system at a far bigger problem
that Lokal already pays humans to solve.

---

## The reframe that makes it a bomb

> **We built this to screen our own engineers. Then we realised we had built the
> thing Lokal Jobs needs most.**

This is not a stretch invented for a demo. Lokal's own Confluence says so:

| What Confluence shows | Where |
|---|---|
| Lokal **already employs a human screening team that phone-calls job seekers**, recording `Is Screened`, `Screened by`, `Screened Timestamp`, `Call/Screening Status`, `Screened_Role Mismatch`, `Screened_Location` | "Seeker ADS improvements for Screening Team", MONETISATI |
| The B2B recruiter product **already has a "screening questions" concept** — static text an advertiser attaches to a job post | "PRD - B2B Enterprise Recruiter Product" |
| Advertisers **churn because candidates waste their time**: lacking the skillset, not turning up for interviews, being rude on calls | "Lokal Jobs Expiry" |
| Revenue runs on **job posts and contact unlocks** — so applicant relevance is directly a revenue lever | Recruiter Dashboard, Jobs Lead System |

So the problem is already identified, already staffed by people, already the
reason paying customers leave, and already adjacent to the money. We built the
machine for it by accident, while solving it for ourselves.

### Why voice, in the seeker's language, is the only thing that works here

A blue- and grey-collar applicant in Warangal has no resume, no laptop, and no
interest in a typed assessment. They have a phone and they speak Telugu. Every
existing AI-interview vendor is English-first, laptop-first and white-collar.
That is not a small gap in coverage; it is the entire market Lokal serves and
nobody is building for it.

**That is the wedge, and it is defensible**: the vernacular voice stack, the
seeker profile data, and the employer relationships all already sit inside
Lokal.

### Proof it already works for that use case

Generated with **no code changes** — the same admin flow, given a Lokal Jobs
posting for a Field Sales Executive in Warangal and a seeker profile instead of
a resume:

- It made the **mandatory two-wheeler and licence** a claim to verify, alongside
  living in Warangal and the Telugu requirement.
- It wrote a real field scenario: *"You visit a kirana shop in Kazipet and the
  owner refuses to order because he disputes an old bill for two cartons of
  biscuits he says he never received. You don't have the delivery records with
  you. What do you do?"* — with a fallback that reaches for his actual mobile-shop
  counter experience if he struggles.
- It spotted a distinction a human screener would miss: his delivery experience
  was **order-driven, not self-routed prospecting**, so visiting 25-30 outlets a
  day on a planned route is genuinely unevidenced.

That output is the pitch. It is not a slide; it is the system doing the job.

---

## Five minutes, structured for these judges

**0:00 — The hook, from the inside.** "Lokal pays people to phone-screen job
seekers one at a time. Employers leave us because candidates waste their time.
We started by fixing this for our own engineering hiring, and ended up with
something that fixes it for the business."

**0:30 — Live demo, in Hindi.** Interview a judge for ninety seconds. Their own
voice, their own words. This is the wow and it needs no explanation.

**2:00 — The scorecard, while it grades.** Show the problem-solver versus
ratta-maar contrast: 82 against 62 on the same rubric. Say the line out loud:
*"we are hiring problem solvers, not people who memorised answers, and the
system can tell the difference."* Then the Round-1 briefing: skip this, probe
that, open with this.

**3:00 — The turn.** The Warangal field-sales scorecard. "Same system, no code
changes. This is Lokal Jobs, in Telugu, at whatever volume the platform has."
Name the three churn reasons from the Expiry page and how a pre-screen kills
each one.

**4:00 — Ship and scale.** One week: S3, Postgres, admin auth, and pointing it
at the existing screening-question fields in the B2B recruiter product. One
month: outbound calls to applicants instead of an inbound link, a ranked
shortlist in the recruiter dashboard, Telugu and Tamil via Sarvam. Own the
limits without being asked: voice-only, no fallback if Bedrock dies, and Nova
Sonic covers Hindi and English today while the other seven languages need a
different engine.

---

## What to add if there is time, in order of payoff

1. **A ranked shortlist view.** The single biggest gap in the story. Right now
   the admin list is one row per candidate. An employer wants *"here are your
   40 applicants, ranked, with the three who actually have a bike and can
   travel."* Even a static sorted table over existing session data closes the
   loop from "we interview one person" to "we solve the funnel".
2. **Outbound framing, even if faked.** Say out loud that the seeker gets a
   WhatsApp link or a call, because that is how Lokal already reaches them
   (the Recruiter-to-Seeker Automated Communication System exists). One slide.
3. **Cost per screen on screen.** Nova Sonic plus grading is cents per
   interview against a salaried screening team and against HireSnap's ₹200.
   Investors want the unit economics; put the number up.
4. **The Slack drop of the briefing.** Thirty minutes of work, and it shows how
   a hiring manager actually receives this without opening a new tool.

## What NOT to do

- Do not lead with the architecture. The Context Pack sanitiser is beautiful and
  it is a 3:30 detail, not a 0:30 one.
- Do not claim it replaces interviews. It replaces the *first phone call*, and
  the honesty is part of why the grading is trustworthy.
- Do not hide the prototype seams. Naming them first is stronger than being
  caught by a question.

---

# The business case, thought through properly

## The one line

> **Lokal Jobs sells employers *access* to candidates. It should sell them
> *screened* candidates. We built the screener.**

That sentence names the current business, the change, and what we did. Everything
below is defending it.

## Is this an internal HR tool or a product? Answer: a product, with internal
## hiring as the proof.

Be clear-eyed about the internal framing, because it is a trap.

**The internal case is real but small.** Screening our own candidates saves an
engineer two to three hours per candidate who should not have reached Round 2.
Across a year of engineering hiring that is a meaningful number of engineer-hours
and worth doing on its own. But it is a **cost saving inside one department at
one company**, and no investor in that room funds that. Pitched as the main
event, it caps the idea at "nice internal tool" and invites the only question we
lose on: *"isn't this just Mercor with extra steps?"*

**So use it as the origin story, not the thesis.** "We were our own first
customer" is the most credible thing we can say about whether it works. It just
is not the reason it matters.

## Why it matters: Lokal Jobs has a screening problem, not a supply problem

The funnel in blue- and grey-collar hiring looks roughly like this, and every
employer on the platform lives it:

```
100 applicants → ~40 you can actually reach on the phone
               → ~15 who are genuinely qualified and still interested
               → ~5 who turn up
               → 1-2 hires
```

The employer pays for access to the 100 and experiences "I called forty people
and wasted my week." That is not a hypothesis — Lokal's own
**"Lokal Jobs Expiry"** page lists why advertisers stop posting, and the reasons
are candidates lacking the skillset, candidates not turning up for interviews,
and candidates being rude on calls. All three are the 100→15 step failing.

Lokal already knows this, which is why there is a **human screening team**
phone-calling seekers, with statuses recorded as `Screened_Role Mismatch` and
`Screened_Location`. The problem is identified, staffed, and expensive. It is
just done serially, by people, in business hours, in the languages those people
happen to speak.

## The trap to avoid: "AI is cheaper than humans" is a WEAK argument in India

Say this before a judge says it to you. A screening agent in India is not
expensive. If the pitch rests on cost-per-call, a sharp investor kills it in one
question, because the labour arbitrage is not there.

**The argument is capacity, coverage and data — not cost:**

1. **Elasticity.** Ten thousand applicants tonight needs no hiring, no training,
   no roster. A human team scales linearly with headcount; this does not.
2. **Coverage.** It calls at 9pm when a seeker is off shift, in Telugu, Hindi or
   Tamil, on a bad connection, on a low-end phone. A seeker with no resume and
   no laptop cannot be screened any other way — voice in their own language is
   the *only* channel that reaches them. Every AI-interview vendor is
   English-first, laptop-first and white-collar. That gap is the entire market
   Lokal serves.
3. **Consistency.** Every candidate gets the same questions and produces
   comparable, structured output. A human screener's notes are not rankable;
   this produces a ranked shortlist with the employer's own must-haves marked
   evidenced, partial or contradicted.
4. **Speed to the employer.** A shortlist in an hour instead of a week, which is
   the difference between filling a role and losing the customer.
5. **Data.** Every conversation is proprietary, structured signal about what a
   seeker can actually *do* — far richer than a self-reported profile form, and
   it compounds into better matching over time. This is the part that is hard to
   copy.

## The actual revenue lever: change what Lokal is able to SELL

This is the heart of it, and it is a pricing argument, not an efficiency one.

Today the platform monetises **access**: pay to post, pay to unlock a contact
number. Access-based pricing has a structural ceiling, because **the employer
bears all the screening risk**. They unlock twenty numbers, eighteen are duds,
and their effective price per useful candidate is brutal. That is what caps
willingness-to-pay and drives the churn on the Expiry page.

Screening moves the risk off the employer:

| | What the employer buys | Who carries the risk |
|---|---|---|
| Today | A job post + N contact unlocks | The employer |
| With screening | N candidates who have been interviewed, ranked, and verified against the requirements they specified | The platform |

A verified, interviewed, still-interested candidate is worth a multiple of a raw
phone number. That is a **pricing-power unlock on the existing monetised
product**, not a new cost centre. And it plugs into machinery that already
exists: the B2B recruiter product already has a screening-questions field, and
the Recruiter-to-Seeker Automated Communication System already reaches seekers
on WhatsApp.

Second-order effect worth naming: it is better for the **seeker** too. Today they
apply and hear nothing. An AI that actually calls them, talks to them in their
language, and tells them they have been shortlisted is a dramatically better
experience on the side of the market Lokal has spent years earning trust with.

## How to present impact without inventing numbers

Do not fabricate Lokal's revenue. Present a **model with visible assumptions**
and let the judges move the dials — investors respect a framework and punish
fake precision. Three lines:

1. **Employer retention.** Advertiser churn attributable to bad-fit candidates,
   times the value of a retained advertiser. Point at the Expiry page for the
   reasons.
2. **Pricing.** Uplift per job post for a "pre-screened candidates" tier versus
   the current post-plus-unlocks price.
3. **Screening capacity.** Cost per screened candidate against the current
   human screening team's cost per call, and — more importantly — the volume
   that becomes reachable at all.

Then the honest internal number as the credibility anchor: engineer-hours saved
per correctly-filtered candidate in our own hiring, which is the version we have
actually run.

## Why now, and why Lokal

- **Why now:** realtime speech-to-speech that can hold a Hindi conversation with
  barge-in became usable on Bedrock only recently. Two years ago this was a
  cascade of speech-to-text, an LLM and text-to-speech with several seconds of
  latency, which is unusable as an interview.
- **Why Lokal:** the seeker base, the employer relationships, the vernacular
  product competence and the trust are all already here. A vendor can build the
  interviewer; nobody else has 250+ districts of seekers who will pick up the
  phone.

## The three questions that could sink it, and the answers

**"Isn't this just Mercor / HireVue / HireSnap?"**
Those screen white-collar candidates in English on laptops. Our candidate has no
resume, no laptop, and speaks Telugu. Same words, completely different product.
And none of them can be a feature inside the platform where the applicants
already are.

**"Why can't Apna or WorkIndia do this tomorrow?"**
They can, and they will. The question is who does it first with real vernacular
coverage and a seeker base that answers the phone. We can ship it into an
existing monetised product in weeks, not build a marketplace first.

**"Will a job seeker actually talk to a robot?"**
This is the real risk and we should say so. It needs testing with actual seekers,
and the design already reflects it: the interviewer speaks their language, never
corrects their English, and the system refuses to penalise a candidate for a
broken connection. If seekers hang up, the honest answer is that we learn that
in week one with a few hundred calls, not after a year of building.

## What NOT to claim

- Do not say it replaces interviews. It replaces the **first phone call**.
- Do not say it removes the screening team. It makes them supervisors of a much
  larger funnel — they review the ranked output instead of dialling.
- Do not promise all ten languages. Hindi and English work today; the rest need
  a different speech engine, and saying so is what makes the rest credible.

---

# THE REAL ANSWER: it is one capability, and Lokal has five instances of it

Researched properly on 4 Sep against Lokal's Confluence and Jira. The
internal-HR framing was not wrong — it was **the smallest of five instances of
the same problem**, and two of the bigger ones already have written PRDs that
have not been built.

## What Lokal is already doing about this, today

| Product | Who gets screened | Current state | Source |
|---|---|---|---|
| **Dostt** | Listeners (experts) | **PRD written, status TO-DO.** Ops teams manually review profiles and conduct interview calls | "Draft 3 PRD: AI-Based Expert Onboarding for Dostt", MONETISATI |
| **Eaze** | Experts | **PRD written** ("Draft 1 PRD"), shared engineering HLD is `[WIP]` | AI-Onboarding (HLD), TECH |
| **Lokal Matrimony** | Female profiles, for fakes | **AI calling already in live experiment** | Jira NMP-1366 |
| **Lokal Jobs** | Job seekers | Dedicated `screening_management` app + human screening team | Sanity Testing doc; "Seeker ADS improvements for Screening Team" |
| **Engineering hiring** | Candidates | Manual HM screen | "Hiring Process - Interns", TECH |

Five funnels, five ops teams, five status taxonomies, one problem: **can this
person actually do the thing they say they can, and are they who they say they
are — established over a phone call, in their language, at volume.**

## Their own numbers, which are the business case

From the Dostt PRD and the shared HLD:

**Eaze expert onboarding**
- Average on-call onboarding TAT: **2-6 days**
- Same-day lead conversion: **~6%**
- Overall lead → expert conversion: **~10%**
- Supply ops dependency: **"Very high"**

**Dostt expert onboarding — and note the trap they are stuck in**
- On-call onboarding: TAT ~2 hours, conversion **~15%**, experts 100% trained in a day
- Bulk onboarding: TAT ~1 hour, conversion **~60%**, but only **~33% trained**

That second pair is the sharpest thing in the entire pitch:

> **Today Lokal chooses between 15% conversion with quality, or 60% conversion
> without it. An AI interview removes the choice.**

You get bulk-onboarding throughput at on-call screening quality. That is not an
efficiency argument, it is the removal of a structural trade-off, and the PM who
wrote that PRD will recognise it instantly.

**And the channel is already proven inside Lokal.** Jira NMP-1366: the CS team's
AI-calling experiment for matrimony female-profile screening is hitting
**~70% call connectivity against ~30% on manual calls.** Someone at Lokal has
already shown that Bharat users pick up for an AI more often than for a human
agent. That kills the "will they even talk to a robot" objection with Lokal's
own data — do not claim it as ours, cite it as evidence.

## Why our build is better than what the PRDs specified

This is the part that makes it more than "we implemented your PRD". Read the
HLD's API contract: `generate-presigned-url` → upload audio → `submit answer` →
poll `interview/result`, with `min_audio_duration_sec: 6`,
`max_audio_duration_sec: 45`, one fixed question at a time.

**That is a recorded voice form, not an interview.** It cannot:

- **Ask a follow-up.** Our interviewer probes a vague answer once — "can you be
  more specific about how you did that?" — which is the single highest-signal
  move in any screen, and the entire reason our grading can tell a problem
  solver from a memoriser.
- **Be interrupted.** Ours yields inside a second when the candidate starts
  talking, because it is a real duplex conversation.
- **Resist memorisation properly.** Their PRD identifies the risk and mitigates
  it by *rotating* a fixed question bank. We generate fresh questions per
  candidate from the role and their own profile, so there is nothing to leak to
  the next lead.
- **Adapt to the person.** Ours escalates when an answer is strong and falls
  back to an easier angle when someone is struggling — which matters enormously
  for Tier 2/3 supply, exactly the friction their problem statement worries
  about.

And the pieces they specified, we already have: audio capture, periodic image
snapshots, a transcript with explicit flags for the ops review queue, and tiered
routing. Our four verdicts map straight onto their Low / Medium / High risk
tiers, and our rubric axes map onto their risk composition (Policy Compliance
30%, Fraud and Off-platform Intent 30%, **Conversational Competence 40%** — that
last one is 40% of their score and is precisely what we measure best).

## So: internal HR, or product? Both — as one thing.

Pitch the **capability**, then show three instances of it. Do not pick one.

> **Lokal runs five separate screening operations with five ops teams. Two have
> PRDs for an AI interview that nobody has built yet. We built the shared engine
> — a real conversation, in any Indian language, that produces evidence instead
> of a score — and it already works across engineering hiring, blue-collar jobs
> and expert onboarding without changing a line of code.**

Order to present them in:

1. **Engineering hiring** (10 seconds) — the origin story and the proof it
   works. "We were our own first customer."
2. **Expert onboarding for Dostt and Eaze** (the main event) — because a PRD
   with real metrics exists and is unbuilt. Quote 15%-vs-60% and 2-6 days. This
   is where a judge sees immediate, fundable impact.
3. **Lokal Jobs** (the scale story) — the biggest volume, the churn reasons, and
   the shift from selling access to selling screened candidates.

Then the one-liner that ties it: *"same engine, three funnels, and it is the
same engine because the question is always the same — can this person actually
do this, in the language they actually speak."*

## What this does to the demo

Add one artifact and the pitch is complete: run the interviewer as a **Dostt
listener onboarding**, in Hindi, using the actual question types from their PRD
(motivation, self-introduction, and a scenario like *"a user says 'I don't know
what to talk about' — what do you say?"* or *"what if a user asks for your
Instagram?"*). That takes minutes — it is just a JD and a profile pasted into
the existing admin flow.

Then in the demo you can say: **"this is the PRD in the Monetisation space,
running."** Nothing else any team presents will land like that.
