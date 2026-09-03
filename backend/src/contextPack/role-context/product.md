# Role context — Product & Product Analytics

Hand-maintained and public-safe, like `company-profile.md`. This file is
DELIBERATELY not run through the sanitizer: the sanitizer's job is to strip
business logic out of engineering documents, and it correctly refuses to turn a
PRD into interview material. Everything here is the kind of thing that appears
in a job ad or a press interview. No metrics, no pricing, no experiment results,
no ranking formulas.

Its only purpose is to let scenario questions be shaped like the work this role
actually does here, instead of a generic "build a dashboard" prompt. Candidates
are never quizzed on any of it.

---

## What a product person here actually works on

A house of separate apps rather than one product: local news and civic
information, jobs for blue- and grey-collar workers, a separate verified-jobs
product, classifieds, matrimony, agricultural advisory, astrology consultations,
regional-language edutainment, and peer-support communities. Teams are small
autonomous pods and people move between products, so the ability to pick up an
unfamiliar domain quickly matters more than depth in one.

## Who the users are

Users in Tier-2 and Tier-3 towns and smaller districts, across many Indian
languages, mostly on low-end Android phones and intermittent connections. A
large share are coming online for the first time. They are not the users most
product people have designed for before, and several instincts do not transfer:

- **Language is not a setting, it is the product.** The same screen has to work
  when every string is longer or a different script.
- **Funnels break at steps that seem trivial.** Phone-number entry, OTP,
  permissions and app-size limits all lose real users.
- **Trust is fragile and load-bearing.** For a jobs or matrimony product, one
  bad experience is not a churned session, it is someone's job search or
  marriage prospect.
- **Offline and flaky-network behaviour is a product decision**, not an
  engineering detail.

## The kind of problem worth reasoning about

Realistic shapes for a scenario question — situational, not trivia:

- A metric moves sharply for one language or one district but not others, and
  the first job is deciding whether it is real, an instrumentation change, or a
  release artefact.
- A funnel step loses users on low-end devices specifically, and the fix has to
  be weighed against app size or a slower first load.
- An experiment reads positive on the primary metric and negative on a guardrail
  one, and someone has to make the call with incomplete follow-up data.
- Two products want the same surface, and the decision needs a rationale beyond
  "whoever asked louder".
- A feature works in one language and is confusing in another once translated.

## How they are expected to work

- Ownership over process: ship it, watch it, fix it.
- Pragmatism over purity: the answer accounts for the constraint that exists,
  not the one they wish existed.
- Honesty about limits: "I don't know, here is how I'd find out" is a strong
  answer; confident bluffing is not.
- Curiosity about the user: they can explain who uses the thing they built and
  why it matters to that person.
