# What We Built — Plain-English Summary

*A simple overview of our AI interview project, written for anyone (no technical
background needed).*

---

## The idea in one line

An **AI interviewer that does the first-round screening call** — it talks to a
candidate, understands their background, and gives the hiring team an honest,
evidence-backed summary of whether the person is worth a deeper interview.

---

## Why we're building it

- Recruiters can't judge deep technical skill, so weak candidates slip through to
  the next round.
- Our **senior engineers then waste their time** discovering this in person — time
  that is our most expensive resource.
- Off-the-shelf AI interviewers only test *generic* skills. Ours tests people
  against **how we actually work** — our real systems, our real trade-offs.

**Goal:** save senior-engineer hours and give the hiring team a clear, fair picture
of each candidate — early.

---

## How it works (the candidate's journey)

1. **Recruiter sets it up.** They paste in the **job description** and the
   candidate's **resume**, pick a length (1–45 minutes), and the system
   automatically **writes a tailored set of interview questions**.
2. **Candidate joins.** They sign in with their **email**, and have a **live spoken
   conversation** with an AI interviewer named "Sarah Chen."
3. **The interview happens.** Sarah asks about their real projects, digs deeper on
   good answers, and keeps it conversational — like a friendly first-round chat,
   not an exam.
4. **The candidate finishes** and sees a simple thank-you page. **They never see a
   score** — that goes only to the hiring team.
5. **The hiring team gets a report card** with strengths, weaknesses, exact quotes,
   and a recommendation on whether to advance them.

---

## What makes ours different

- **Tailored to the role.** A frontend designer gets frontend questions; a data
  analyst gets data questions. It never asks the wrong kind of question.
- **Grounded in our reality.** Questions are shaped by how *our* company actually
  builds things — something no outside vendor can copy.
- **Evidence, not a mystery score.** Every rating comes with a **real quote** from
  the candidate, so the hiring manager can trust it.
- **Fair by design.** A quiet or nervous candidate isn't penalized. Missing a skill
  they can learn on the job isn't held against them.
- **Works in multiple languages** — English, Hindi, or a mix.
- **Cheat-detection built in.** The camera watches (respectfully) for red flags —
  another person in the room, a phone, or reading answers off-screen — and captures
  a short clip so the recruiter can check. This **never affects the technical
  score**; it's only an honesty signal.

---

## The AI models we used

| Job it does | Model | Provider |
|---|---|---|
| **The live voice interview** (listening + speaking in real time) | **Amazon Nova Sonic** | Amazon (AWS) |
| **Writing the interview questions** from the JD + resume | **Claude Sonnet 4.6** | Amazon Bedrock (Anthropic's Claude) |
| **Grading the interview** and writing the report card | **Claude Sonnet 4.6** | Amazon Bedrock (Anthropic's Claude) |
| **Backup brain** (if the main one is unavailable) | Claude / GPT models via **OpenRouter** | OpenRouter |
| **Cheat detection** (face & phone spotting in the browser) | **Google MediaPipe** | Google (runs on the candidate's own device) |

**In short:** the thinking is done by **Claude (on Amazon Bedrock)**, the talking is
done by **Amazon Nova Sonic**, and the camera-based honesty checks run on **Google
MediaPipe** right in the browser.

*We also evaluated Google's Gemini Live and OpenAI's Realtime voice models as
alternatives for the spoken part, because Nova Sonic occasionally drops the
connection.*

---

## Where we are today

- ✅ The **full journey works** end to end: set up → interview → report card.
- ✅ The interview is **role-aware, multi-language, and fair**, with cheat-detection
  and an evidence-based report card.
- ✅ If a call **drops, it reconnects on its own** and picks up where it left off,
  without confusing the candidate.
- ⚠️ The voice model (Nova Sonic) sometimes hiccups — we've built automatic recovery
  around it, and are weighing more stable alternatives.
- ⚠️ Currently running on **temporary demo credentials** that expire; a real
  deployment needs permanent ones.

---

## What's still to come

- A more stable voice model, if needed.
- Proper long-term storage for recordings and results.
- Login/security on the recruiter dashboard.
- Real production hosting.

---

*This is a working prototype — the core experience is real and demonstrable today.*
