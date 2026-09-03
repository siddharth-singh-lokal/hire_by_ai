# Role context — Mobile (Android / React Native)

Hand-maintained and public-safe, like `company-profile.md`, and deliberately
NOT run through the sanitizer (see the note in `product.md`). No business logic.
Candidates are never quizzed on it; it exists so scenario questions look like
the actual job.

---

## What a mobile engineer here actually works on

Consumer apps across a house of products — local news and civic information,
jobs, classifieds, matrimony, agricultural advisory, astrology consultations,
regional-language edutainment. Native Android (Kotlin) and React Native both
exist, and pods are small enough that one person often owns a whole feature from
API integration to release.

## The constraints that shape every decision

- **Low-end devices are the target, not the edge case.** Entry-level Android
  phones with little RAM, modest CPUs and limited storage. Memory pressure and
  background-process death are normal conditions.
- **App size is a growth metric.** Every added dependency has a download-
  conversion cost in markets where data is metered.
- **Networks are intermittent.** Requests fail mid-flight, sessions resume on a
  different connection, and "assume it worked" is a bug. Offline and retry
  behaviour is part of the feature, not a follow-up ticket.
- **Ten-plus languages and scripts.** Layouts have to survive strings that are
  twice as long and scripts with different line heights; text rendering and font
  fallbacks are real work.
- **Media is heavy.** Images and video for a feed have to be sized and cached
  deliberately, on devices that cannot absorb waste.
- **Fast iteration.** Priorities shift, so scoping and sequencing judgment
  matters as much as implementation.

## The kind of problem worth reasoning about

- A screen is smooth on a test device and janky on an entry-level phone, and the
  candidate has to reason about where the time actually goes before optimising.
- A list with images grows its memory use the longer a user scrolls.
- A feature works until the process is killed in the background and the user
  returns to a broken state.
- A network call succeeds on the server but the client never hears back, and the
  user should not end up double-submitting.
- A layout that is fine in English breaks once the strings are translated.
- A new dependency would save a week of work and add noticeably to app size.

## How they are expected to work

- Ownership over process: ship it, watch it, fix it — including the crash
  reports afterwards.
- Reason about what a device can actually do before adding capacity or
  dependencies.
- Honesty about limits: "I don't know, here is how I'd find out" is a strong
  answer.
- Curiosity about the user: they can explain who is holding the phone and what
  breaks for that person.
