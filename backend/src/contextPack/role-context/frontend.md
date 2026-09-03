# Role context — Frontend & Web

Hand-maintained and public-safe, like `company-profile.md`, and deliberately
NOT run through the sanitizer (see the note in `product.md`). No business logic.
Candidates are never quizzed on it; it exists so scenario questions look like
the actual job.

---

## What a frontend engineer here actually works on

Web surfaces around a house of consumer apps — public content and listing pages
that need to be findable and load fast on a slow connection, plus internal
consoles for the operations and support teams who keep those products running.
Small autonomous pods, so a single person often owns a surface end to end.

## The constraints that shape every decision

- **The visitor is on a low-end phone on a slow connection.** Bundle size,
  render-blocking work and image weight are user-facing problems, not lint
  warnings.
- **Ten-plus languages and scripts.** Layouts have to hold when strings double
  in length or switch script; fonts and line heights are real work, and text
  cannot be baked into images.
- **Public pages have to be discoverable**, so what renders on the server versus
  the client is a deliberate decision.
- **Internal tools are used all day by non-engineers.** Dense data, keyboard
  speed and unambiguous states matter more than visual novelty; a confusing
  control costs someone else their afternoon.
- **Cost-conscious infrastructure.** Caching and payload size are engineering
  constraints, not afterthoughts.
- **Fast iteration.** Priorities shift, so scoping judgment matters as much as
  implementation.

## The kind of problem worth reasoning about

- A page is fast on a laptop and slow on an entry-level phone, and the candidate
  has to reason about where the time goes before optimising.
- A list or feed grows heavier the longer someone scrolls.
- A form loses a user's input when the network drops mid-submit.
- A layout that is fine in English breaks once translated.
- An internal console needs to show a lot of data without becoming unreadable.
- A component is needed in two products with slightly different requirements.

## How they are expected to work

- Ownership over process: ship it, watch it, fix it.
- Reason about what the device and the connection can actually do.
- Honesty about limits: "I don't know, here is how I'd find out" is a strong
  answer.
- Curiosity about the user: they can explain who is on the other end and what
  breaks for that person.
