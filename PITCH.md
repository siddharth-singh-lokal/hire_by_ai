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
