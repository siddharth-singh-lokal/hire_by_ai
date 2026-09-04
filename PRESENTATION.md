# Five minutes. Problem → Solution → Demo.

Built against the judging guidance: keep it to three beats, prove the problem is
real, quantify in absolute numbers, show rather than tell, and have an answer
for "why not just ChatGPT".

**The one sentence a judge should be able to repeat afterwards:**

> Lokal's first-round filter is a DSA test its own engineering docs say does not
> predict success, so senior engineers discover the mismatch in hour-long
> interviews instead. We replaced it with an AI that actually talks to the
> candidate about the work they did, in their own language, for about ₹60 a
> screen — returning roughly 12 senior-engineer working days a year, and paying
> for itself many times over if it prevents a single bad hire.

---

## Beat 1 — Problem (60 seconds)

Do not open with "hiring is hard". Open with the receipt.

> "Our own intern hiring doc, in the TECH space on Confluence, says this:
> *'We are seeing some very high scored candidates which fail in later rounds.
> Hence this is being treated as an elimination round instead of a selection
> round.'*
>
> That is our engineering org writing down, in its own documentation, that the
> filter at the top of our funnel does not predict who succeeds. So the
> mismatch gets discovered later — by an SDE2, in a 60 to 90 minute round, from
> the same doc."

### How we know the problem is real — three independent sources

1. **Written internal admission.** The Confluence quote above. Not an opinion,
   a documented decision to downgrade the round because it mis-predicts.
2. **We ran it and watched it happen.** Two real screening interviews with our
   own intern candidates. One could not describe the Socket.io flow from his own
   resume project after two direct prompts. That is exactly the mismatch an SDE2
   would otherwise have found an hour into R2.
3. **The cost is written down too.** From the `SDE 2 & 3` Confluence page, R2 is
   45-75 minutes and R3 is 57-87 minutes of senior engineering time, per
   candidate.

**Who faces it:** recruiters, who cannot assess technical depth; hiring
managers, who screen resumes by hand at stage 1; and senior engineers, who pay
for both mistakes in hours.

---

## Beat 2 — Solution (60 seconds)

One screen, three claims. No architecture.

> "You give it the job description and the résumé. It writes a **different
> interview for every candidate**, calls them, has a real conversation in
> English, Hindi or Hinglish, and hands the hiring manager evidence — verbatim
> quotes, which requirements the conversation actually established, and what
> Round 1 should skip and probe."

The three claims, in the order that matters:

1. **It is not a question bank.** Every interview is generated from that JD and
   that résumé. Nothing to leak, nothing to memorise.
2. **It grades thinking, not vocabulary.** Explicitly built for problem solvers
   over rote recall.
3. **It refuses to judge unfairly.** If our own platform breaks the call, it says
   so instead of blaming the candidate.

---

## Beat 3 — Demo (2 minutes 30). This is where the time goes.

Four moves. Rehearse the transitions, not the words.

### Move 1 — Generation, live, with a role the judges choose (40s)

> "Name a role Lokal hires for."

Paste that JD, hit generate. In about forty seconds you get role-appropriate
questions, a rubric invented for that role, and a list of requirements the
résumé does not evidence.

**Why this move is first:** it is unfakeable, and it proves generality without
you having to argue for it. A pre-canned demo cannot do this.

### Move 2 — The interview, in Hindi, with a judge (60s)

Interview whoever volunteers. Ninety seconds. Let them interrupt it — it stops
mid-sentence and listens, which is the moment it stops feeling like a form.

Have all four judges' public bios pre-loaded as résumés so it asks them about
their own work. That takes five minutes of prep this morning and it is the
single highest-impact thing you can do before noon.

### Move 3 — The fairness reveal (30s)

Pull up the real scorecard: **Do not advance, 22.**

> "That is a real candidate. His call dropped four times that day. Watch."

Re-grade. It becomes **Needs discussion, re-screen recommended**, with a banner
above the verdict saying the platform failed, not the person.

> "Every AI interview product scores people. This is the only one I know of that
> refuses to reject someone because our infrastructure broke."

That is your trust moment. It is what makes a judge believe the other scores.

### Move 4 — Problem solver versus ratta-maar (20s)

Two candidates, same rubric, side by side:

- Admits he forgot the method names, then reasons correctly through the
  durability trade-off and diagnoses a cache stampede from first principles:
  **Advance, 82.**
- Fluently says "thundering herd, XFetch, at-least-once semantics", cannot
  explain why the spike lands at the same time daily: **Advance with focus, 62**,
  flagged *reasoning collapses under follow-up*.

> "We are hiring problem solvers, not people who memorised answers. It can tell
> the difference."

---

## The numbers slide — absolute, with assumptions visible

Put the assumptions on the screen. A judge who disagrees can move a dial, and
that is a conversation rather than a challenge.

**Assumptions:** 30 engineering hires a year; 10 candidates reach R2 per hire;
Round-0 correctly filters a quarter of them before R2; an R2 costs 60 minutes
plus 15 minutes of write-up.

| | |
|---|---|
| R2 interviews a year | 300 |
| Correctly filtered before R2 | 75 |
| Senior engineer time returned | **94 hours ≈ 12 working days a year** |
| Cost to run all 300 screens | **about ₹18,000 a year** (≈ ₹60 each) |
| Commodity comparison | HireSnap, ₹200 a session |
| **One wrong SDE2 hire** | **₹8-15 lakh** — ramp salary, severance, re-hire, team disruption |

State the conclusion plainly, because it is stronger than the savings:

> "The direct saving is twelve senior engineer days a year. But the real number
> is the last row. Our own docs say the current filter passes people who fail
> later, and some of those get hired. Running this for a whole year costs
> ₹18,000. One bad SDE2 hire costs about ₹10 lakh. **That is a 56x ratio — the
> system pays for itself fifty-six times over if it prevents a single bad hire.**"

The 56x is the number to say out loud and leave on screen. It is the one a judge
will repeat back to you.

Frame it as **cheap insurance against an expensive error**, not as cost cutting.

### The roadmap number, in 15 seconds, using their own metrics

> "The same engine already runs a Dostt listener onboarding and a Warangal field
> sales screen with no code changes. There are PRDs in the Monetisation space
> for AI expert onboarding for Dostt and Eaze, both unbuilt. Eaze's own numbers:
> lead-to-expert conversion **10%**, onboarding TAT **2 to 6 days**, ops
> dependency 'very high'. Dostt is forced to choose between **15%** conversion
> with quality and **60%** without it. Those leads come from paid ads, so
> conversion is CAC. That is where this gets big."

Plant it and stop. Do not pitch it.

---

## "Why not just ChatGPT?"

Have this ready, and answer in this order — channel first, because it is the
part that is physically impossible.

1. **ChatGPT cannot phone forty candidates tonight in Hindi.** There is no
   real-time voice interview, no turn-taking, no interruption handling. Our
   candidate has no laptop and does not want to type — voice in their own
   language is the only channel that reaches them.
2. **No workflow.** No JD-and-résumé pipeline, no per-candidate generation, no
   scheduling, no recording, no ranked shortlist. Somebody would be pasting
   prompts by hand, once per candidate.
3. **No comparability.** A rubric held constant across candidates is the whole
   point. Ad-hoc prompting gives you forty incomparable opinions.
4. **No org context.** It does not know that our infrastructure is deliberately
   cost-constrained, that users are on low-end phones in ten languages, or what
   a field sales day in Warangal looks like.
5. **No integrity layer.** No proctoring evidence, no verbatim citations, and
   nothing that says "this call was broken, do not blame the candidate."
6. **Governance.** Candidate résumés and interview recordings pasted into a
   consumer chatbot is a compliance problem. This runs inside Lokal's own AWS
   account.

The closing line:

> "ChatGPT is a model. This is a workflow with a voice channel, a fixed rubric,
> an audit trail, and a deliberate refusal to penalise a candidate for our own
> bugs. The model is the cheapest part of it."

---

## Own the limits before you are asked (15 seconds, near the end)

> "Honestly: it is voice only, so it is not a coding round. Hindi and English
> work today; the other Indian languages need a different speech engine, and we
> are not pretending otherwise. There is no auth on the admin console and no
> database yet. One week gets us object storage, Postgres and auth. And the
> real open question is whether job seekers will talk to a bot at scale — though
> our own CS team's AI-calling experiment is seeing **70% call connectivity
> against 30% on manual calls**, which suggests they will."

Volunteering the weaknesses is what makes the strengths credible to investors.

---

## Pre-flight, the morning of — do this in order

1. **Refresh the AWS credentials.** They are temporary workshop credentials and
   they have expired three times in the last twelve hours, roughly every two to
   four hours. Paste a fresh key/secret/session-token triple into
   `backend/.env`; the code now hot-reloads them, so no restart is needed.
   **Do this within the hour before you present, not the night before.**
2. **Run `npm run e2e`.** If it passes, the demo works. If it fails on
   `ExpiredTokenException`, go back to step 1.
3. **Pre-load the four judges' public bios** as résumés so the interviewer can
   ask them about their own work. Five minutes, highest impact per minute.
4. **Prepare three or four candidates for one role** and run two, so the
   shortlist shows a real ranking rather than a single row.
5. **Record a backup** of one Hindi interview and one completed scorecard.
   Credentials dying mid-demo is the single most likely failure, and a recording
   makes it survivable.
6. **Wired headphones.** Bluetooth drops to a hands-free codec when the mic
   opens and she will sound tinny regardless of the code.

## Delivery notes

- **Do not explain the architecture.** No Context Pack, no sanitiser, no Nova
  Sonic. If asked, one sentence: it runs entirely on Bedrock inside our own AWS.
- **Talk while it loads.** Generation takes about forty seconds and grading
  about a minute. Fill both with the numbers slide, deliberately.
- **Have a recorded backup** of the Hindi interview and one completed scorecard.
  If the live call fails, switch without commentary.
- **Rehearse twice against a clock.** Over-running is penalised.
- Refresh the AWS credentials and run `npm run e2e` once before you present. If
  that passes, the demo works.
