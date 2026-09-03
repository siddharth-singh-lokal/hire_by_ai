# Role context — Data & Analytics

Hand-maintained and public-safe, like `company-profile.md`, and deliberately
NOT run through the sanitizer (see the note in `product.md`). No metrics, no
pricing, no experiment results, no formulas. Candidates are never quizzed on it;
it exists so scenario questions look like the actual job.

---

## What a data person here actually works on

Analytics across a house of separate apps — local news and civic information,
jobs, verified jobs, classifieds, matrimony, agricultural advisory, astrology
consultations, regional-language edutainment, peer support. Small autonomous
pods, so an analyst usually supports more than one product and switches between
them. Work runs from event instrumentation through to the recommendation a
product or business team acts on.

Typical surface: SQL over a cloud warehouse, event streams from mobile clients
alongside backend transactional tables, and dashboards in a self-serve BI tool.
Cost matters — a query that scans everything is a real expense, not just slow.

## What makes the data here harder than it looks

- **Mobile event data is lossy by nature.** Low-end Android devices,
  intermittent connectivity and app-kill behaviour mean events arrive late, out
  of order, or not at all. "The number dropped" and "the events stopped
  arriving" look identical at first glance.
- **App releases change the data.** A staged rollout can shift a metric purely
  through instrumentation, and version is almost always a dimension worth
  cutting by.
- **Language and district are first-class dimensions.** An aggregate can hide
  opposite movements in two languages.
- **Joining frontend behaviour to backend records is where the errors live** —
  identity, timing and definition mismatches between the two sides.
- **Cohort definitions decide the answer.** A retention number is meaningless
  until it is clear which install cohort and which activity definition it uses.

## The kind of problem worth reasoning about

- A daily metric moves sharply and the first job is separating a real change
  from a tracking or release artefact, before anyone acts on it.
- A dashboard everyone trusts turns out to disagree with a backend source of
  truth, and someone has to work out which is wrong and why.
- A stakeholder asks for a number by end of day and the honest answer needs a
  caveat about what the data can and cannot support.
- An aggregate looks flat while two segments move in opposite directions.
- A scheduled query starts costing far more than it should after an upstream
  change.

## How they are expected to work

- Check whether the data is real before explaining it.
- Say what a number does and does not establish; a confident wrong answer is
  worse than a hedged right one.
- Write for the person acting on it, not for another analyst.
- Curiosity about the user: they can say who is behind the numbers and why the
  movement matters to that person.
