/**
 * End-to-end harness for the Nova Sonic interview relay.
 *
 * Drives ws://<host>/ws/interview exactly as the browser does — streams silence
 * so Sonic's VAD closes turns, answers with scripted candidate lines, then polls
 * the scorecard — so the whole flow (voice stream, reconnect, grading, call
 * quality, language) can be verified without a microphone.
 *
 * The voice path's failure modes only reproduce against the live relay, so this
 * runs against a running backend rather than mocking Bedrock.
 *
 *   npm run e2e                       # one English run against the fixture
 *   npm run e2e -- --loop 3           # measure the Bedrock drop rate
 *   npm run e2e -- --lang hi          # Hindi run, writes e2e-hi.wav to listen to
 *   npm run e2e -- --session <id>     # drive a session prepared in the admin UI
 *
 * Needs the backend up with NODE_ENV unset (so /api/dev/prepare-from-bank is on).
 */

import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import dotenv from "dotenv";
import type { QuestionBank } from "../src/questionBank";
import type { GroundedScorecard } from "../src/scorecardTypes";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// --- language matrix (Unicode range per script + a real answer to speak) ------

type LangCode = "en" | "hi" | "te" | "ta" | "kn" | "ml" | "mr" | "gu" | "bn";
const LANGS: Record<LangCode, { label: string; script: RegExp; turn: string }> = {
  en: { label: "English", script: /[A-Za-z]/, turn: "I used Redis to cache the expensive query, and response time dropped by about half." },
  hi: { label: "Hindi", script: /[ऀ-ॿ]/, turn: "मैंने अपने प्रोजेक्ट में Redis का इस्तेमाल caching के लिए किया था, जिससे API का response time लगभग आधा हो गया।" },
  mr: { label: "Marathi", script: /[ऀ-ॿ]/, turn: "मी माझ्या प्रोजेक्टमध्ये Redis वापरून caching केली, त्यामुळे response time जवळपास निम्मा झाला." },
  te: { label: "Telugu", script: /[ఀ-౿]/, turn: "నేను నా ప్రాజెక్ట్‌లో caching కోసం Redis వాడాను, దాంతో response time దాదాపు సగం తగ్గింది." },
  ta: { label: "Tamil", script: /[஀-௿]/, turn: "நான் என் project-ல் caching-க்கு Redis பயன்படுத்தினேன், response time கிட்டத்தட்ட பாதியாக குறைந்தது." },
  kn: { label: "Kannada", script: /[ಀ-೿]/, turn: "ನಾನು ನನ್ನ project ನಲ್ಲಿ caching ಗಾಗಿ Redis ಬಳಸಿದೆ, response time ಸುಮಾರು ಅರ್ಧದಷ್ಟು ಕಡಿಮೆಯಾಯಿತು." },
  ml: { label: "Malayalam", script: /[ഀ-ൿ]/, turn: "ഞാൻ എന്റെ project-ൽ caching-നായി Redis ഉപയോഗിച്ചു, response time ഏകദേശം പകുതിയായി കുറഞ്ഞു." },
  gu: { label: "Gujarati", script: /[઀-૿]/, turn: "મેં મારા project માં caching માટે Redis વાપર્યું, જેથી response time લગભગ અડધું થઈ ગયું." },
  bn: { label: "Bengali", script: /[ঀ-৿]/, turn: "আমি আমার project-এ caching-এর জন্য Redis ব্যবহার করেছি, তাতে response time প্রায় অর্ধেক কমে গেছে।" },
};

// --- args ---------------------------------------------------------------------

interface Args {
  lang?: LangCode;
  loop: number;
  minutes?: number;
  port: number;
  session?: string;
  fromSession?: string;
  fixture: string;
  turnTimeoutMs: number;
  gradeTimeoutMs: number;
  probe: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  const port =
    Number(get("--port")) ||
    Number(process.env.E2E_PORT) ||
    Number(process.env.PORT) ||
    4000;
  return {
    lang: get("--lang") as LangCode | undefined,
    loop: Number(get("--loop")) || 1,
    minutes: get("--minutes") ? Number(get("--minutes")) : undefined,
    port,
    session: get("--session"),
    fromSession: get("--from-session"),
    fixture: get("--fixture") || path.join(__dirname, "fixtures", "backend-intern.bank.json"),
    turnTimeoutMs: (Number(get("--turn-timeout")) || 45) * 1000,
    gradeTimeoutMs: (Number(get("--grade-timeout")) || 150) * 1000,
    probe: has("--probe"),
  };
}

// --- helpers ------------------------------------------------------------------

const SILENCE = Buffer.alloc(1024).toString("base64"); // 512 samples @16kHz = 32ms
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadFixture(p: string): QuestionBank {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function httpJson(url: string, init?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Scripted candidate turns. Avoids END_INTENT phrasings ("I'm done", "wrap up"). */
function buildScript(a: Args): string[] {
  const langTurn = a.lang ? LANGS[a.lang].turn : null;
  const base = [
    "Sure, happy to. On the server side, when a message comes in the socket server receives it, looks up the recipient's socket by their user id, and emits the event to that connection if they're online.",
    langTurn ??
      "If the recipient is offline I store the message in the database with a delivered flag, and push it to them when they reconnect and re-subscribe.",
    "For the daily database spike, my first guess is a cache stampede — the cached query has a fixed TTL, so all the keys expire together and every request hits the database at once.",
    "I'd confirm it by lining up the spike with the TTL window, then add jitter to the expiry and pre-warm the cache in the background so they don't all expire at the same moment.",
    "That covers what I'd look at first. I'd also check whether the query itself needs an index, since taking the database down suggests it's expensive on its own.",
    "Thanks, that's everything from my side on these.",
  ];
  return base;
}

// --- metrics ------------------------------------------------------------------

interface RunMetrics {
  sessionId: string;
  ttfaMs: number | null;
  audioBytes: number;
  pcmChunks: Buffer[];
  lines: { candidate: number; interviewer: number };
  transcript: { sender: string; text: string }[];
  drops: number;
  interrupts: number;
  readyCount: number;
  turnsSent: number;
  stalls: number;
  errors: string[];
  scriptHits: number;
  sampleInterviewerLine: string;
}

interface IterationResult {
  metrics: RunMetrics;
  rubricAxes: number;
  role: string;
  durationMinutes: number;
  gradingMs: number;
  scorecard?: GroundedScorecard;
  failures: string[];
}

// --- session prep -------------------------------------------------------------

async function prepareSession(
  base: string,
  a: Args
): Promise<{ sessionId: string; rubricAxes: number; role: string; durationMinutes: number }> {
  if (a.session) {
    // Drive an existing (admin-prepared) session. Learn its rubric size from the
    // admin detail route. Note: a ready session can only be driven once.
    const { status, body } = await httpJson(`${base}/api/admin/sessions/${a.session}`);
    if (status !== 200 || !body.session) throw new Error(`--session ${a.session} not found`);
    const s = body.session;
    return {
      sessionId: s.id,
      rubricAxes: s.bank.rubric.length,
      role: s.bank.role,
      durationMinutes: s.bank.durationMinutes,
    };
  }

  const payload: any = { language: a.lang && a.lang !== "en" ? a.lang : "en" };
  if (a.fromSession) payload.fromSessionId = a.fromSession;
  else payload.bank = loadFixture(a.fixture);

  const { status, body } = await httpJson(`${base}/api/dev/prepare-from-bank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (status === 404) {
    throw new Error(
      "dev route missing — start the backend with NODE_ENV unset (npm run dev), or use --session <id>"
    );
  }
  if (status !== 200 || !body.sessionId) {
    throw new Error(`prepare-from-bank failed (${status}): ${body.message || JSON.stringify(body)}`);
  }
  return {
    sessionId: body.sessionId,
    rubricAxes: body.rubricAxes,
    role: body.role,
    durationMinutes: body.durationMinutes,
  };
}

// --- the interview state machine ---------------------------------------------

function runInterview(
  base: string,
  sessionId: string,
  script: string[],
  a: Args
): Promise<RunMetrics> {
  return new Promise((resolve, reject) => {
    const wsUrl = base.replace(/^http/, "ws") + `/ws/interview?sessionId=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);

    const m: RunMetrics = {
      sessionId,
      ttfaMs: null,
      audioBytes: 0,
      pcmChunks: [],
      lines: { candidate: 0, interviewer: 0 },
      transcript: [],
      drops: 0,
      interrupts: 0,
      readyCount: 0,
      turnsSent: 0,
      stalls: 0,
      errors: [],
      scriptHits: 0,
      sampleInterviewerLine: "",
    };

    let tReady = 0;
    let silenceTimer: ReturnType<typeof setInterval> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let replyTimer: ReturnType<typeof setTimeout> | null = null;
    let scriptIdx = 0;
    let interviewerSpeaking = false;
    let concluded = false;
    let ready = false;
    let windDownSent = false;
    let done = false;
    let pendingTurnAfterReady = false;
    const startWall = Date.now();
    const scriptRe = a.lang ? LANGS[a.lang].script : null;

    const connectTimeout = setTimeout(() => fail("timed out connecting to relay"), 15000);

    function cleanup() {
      if (silenceTimer) clearInterval(silenceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (replyTimer) clearTimeout(replyTimer);
      clearTimeout(connectTimeout);
    }
    function fail(msg: string) {
      if (done) return;
      done = true;
      m.errors.push(msg);
      cleanup();
      try { ws.close(); } catch {}
      reject(new Error(msg));
    }
    function finishOk() {
      if (done) return;
      done = true;
      cleanup();
      resolve(m);
    }
    function send(obj: any) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }
    function startReplyTimeout() {
      if (replyTimer) clearTimeout(replyTimer);
      replyTimer = setTimeout(() => {
        m.stalls++;
        if (m.stalls >= 2) { send({ type: "terminate", reason: "e2e: no reply" }); }
        else dispatchTurn();
      }, a.turnTimeoutMs);
    }
    function dispatchTurn() {
      if (done || concluded) return;
      if (!ready) { pendingTurnAfterReady = true; return; }

      const overTime = a.minutes != null && Date.now() - startWall >= a.minutes * 60000;
      if (overTime && !windDownSent) { windDownSent = true; send({ type: "wind_down" }); }

      if (scriptIdx >= script.length || (overTime && windDownSent && scriptIdx > 0)) {
        send({ type: "terminate", reason: "e2e complete" });
        return;
      }
      const text = script[scriptIdx++];
      send({ type: "text_input", text });
      m.turnsSent++;
      if (a.probe && m.turnsSent === 2) {
        send({ type: "proctor_probe", description: "Another person may be visible in the frame" });
      }
      startReplyTimeout();
    }

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case "ready": {
          m.readyCount++;
          ready = true;
          clearTimeout(connectTimeout);
          if (!tReady) tReady = Date.now();
          if (!silenceTimer) {
            silenceTimer = setInterval(() => send({ type: "audio", data: SILENCE }), 32);
          }
          // First turn kicks the conversation after the greeting. On a resume the
          // model waits for the candidate to speak, so nudge either way.
          if (m.readyCount === 1) setTimeout(() => dispatchTurn(), 1500);
          else if (pendingTurnAfterReady) { pendingTurnAfterReady = false; setTimeout(dispatchTurn, 1000); }
          break;
        }
        case "speech_start":
          interviewerSpeaking = true;
          if (settleTimer) clearTimeout(settleTimer);
          if (replyTimer) clearTimeout(replyTimer); // reply has begun
          break;
        case "audio": {
          const buf = Buffer.from(msg.data, "base64");
          m.pcmChunks.push(buf);
          m.audioBytes += buf.length;
          if (m.ttfaMs == null && tReady) m.ttfaMs = Date.now() - tReady;
          break;
        }
        case "transcript": {
          const sender = msg.sender === "candidate" ? "candidate" : "interviewer";
          m.lines[sender]++;
          m.transcript.push({ sender, text: msg.text });
          if (sender === "interviewer") {
            if (!m.sampleInterviewerLine) m.sampleInterviewerLine = msg.text;
            if (scriptRe && scriptRe.test(msg.text)) m.scriptHits++;
          }
          break;
        }
        case "speech_end":
          interviewerSpeaking = false;
          if (settleTimer) clearTimeout(settleTimer);
          // Sonic can emit multiple AUDIO blocks per turn; wait for a lull.
          settleTimer = setTimeout(() => { if (!interviewerSpeaking) dispatchTurn(); }, 1500);
          break;
        case "reconnecting":
          m.drops++;
          ready = false;
          break;
        case "interrupted":
          m.interrupts++;
          break;
        case "end_requested":
          break;
        case "concluded":
          concluded = true;
          // Interviewer said her closing line; mirror the browser — wait for her
          // audio, then stop (terminate would inject a second goodbye).
          setTimeout(() => send({ type: "stop" }), 8000);
          break;
        case "error":
          m.errors.push(`${msg.error || "ERROR"}: ${msg.message || ""}`);
          if (msg.error === "NO_SESSION" || msg.recoverable === false) fail(m.errors[m.errors.length - 1]);
          break;
        case "closed":
          finishOk();
          break;
      }
    });

    ws.on("close", () => { if (!done) finishOk(); });
    ws.on("error", (e: Error) => fail(`ws error: ${e.message}`));

    // Hard cap so a wedged run can't hang the suite.
    setTimeout(() => { if (!done) { send({ type: "stop" }); setTimeout(finishOk, 2000); } },
      (a.minutes ? a.minutes * 60000 : 0) + 240000);
  });
}

// --- scorecard poll + assertions ---------------------------------------------

async function pollScorecard(
  base: string,
  id: string,
  timeoutMs: number
): Promise<{ status: string; evaluation?: GroundedScorecard; message?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await httpJson(`${base}/api/scorecard/${id}`);
    if (body.status === "completed" && body.evaluation) return body;
    if (body.status === "failed") return body;
    if (body.status === "terminated") return { status: "terminated", message: "no candidate turns recorded" };
    await sleep(2000);
  }
  return { status: "timeout", message: `scorecard not ready in ${timeoutMs / 1000}s` };
}

function assertScorecard(m: RunMetrics, ev: GroundedScorecard, rubricAxes: number): string[] {
  const f: string[] = [];
  const verdicts = ["Advance", "Advance with focus", "Needs discussion", "Do not advance"];
  if (!verdicts.includes(ev.verdict)) f.push(`bad verdict: ${ev.verdict}`);
  if ((ev.axisScores?.length ?? 0) !== rubricAxes) f.push(`axisScores ${ev.axisScores?.length} != rubric ${rubricAxes}`);
  if (!["clean", "degraded", "compromised"].includes(ev.screenQuality as string)) f.push(`bad screenQuality: ${ev.screenQuality}`);
  if (typeof ev.streamDrops !== "number") f.push("streamDrops missing");
  else if (ev.streamDrops !== m.drops) f.push(`streamDrops ${ev.streamDrops} != observed ${m.drops}`);
  if (m.lines.interviewer === 0) f.push("no interviewer transcript lines");
  if (m.audioBytes === 0) f.push("no audio received");
  if (m.errors.length) f.push(`errors: ${m.errors.join("; ")}`);
  return f;
}

// --- wav ----------------------------------------------------------------------

function writeWav(p: string, pcm: Buffer, sampleRate = 24000): void {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(p, Buffer.concat([h, pcm]));
}

// --- report -------------------------------------------------------------------

function printIteration(n: number, r: IterationResult, a: Args) {
  const m = r.metrics;
  const ok = r.failures.length === 0;
  const sc = r.scorecard;
  console.log(`\ne2e #${n}  ${ok ? "PASS" : "FAIL"}  session ${m.sessionId}  ${r.role} ${r.durationMinutes}min${a.lang ? `  lang=${a.lang}` : ""}`);
  console.log(`  ready ${m.readyCount}x | first audio ${m.ttfaMs != null ? (m.ttfaMs / 1000).toFixed(1) + "s" : "—"} | audio ${(m.audioBytes / 48000).toFixed(1)}s | turns ${m.turnsSent} | lines cand ${m.lines.candidate} / int ${m.lines.interviewer}`);
  console.log(`  drops ${m.drops} (server ${sc?.streamDrops ?? "?"}) | interrupts ${m.interrupts} | stalls ${m.stalls} | errors ${m.errors.length}`);
  if (sc) console.log(`  grading ${(r.gradingMs / 1000).toFixed(1)}s -> ${sc.verdict} ${sc.overallScore}  axes ${sc.axisScores?.length}/${r.rubricAxes}  quality ${sc.screenQuality}`);
  if (a.lang) console.log(`  lang ${a.lang}: interviewer script hits ${m.scriptHits}/${m.lines.interviewer}, sample: "${m.sampleInterviewerLine.slice(0, 80)}"`);
  if (!ok) console.log(`  FAILURES: ${r.failures.join(" | ")}`);
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const base = `http://localhost:${a.port}`;

  // fail fast if the backend is down
  const health = await httpJson(`${base}/api/health`).catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`Backend not reachable at ${base} — start it first (npm run dev in backend/).`);
    return 2;
  }

  const results: IterationResult[] = [];
  for (let i = 0; i < a.loop; i++) {
    try {
      const prep = await prepareSession(base, a);
      const script = buildScript(a);
      const metrics = await runInterview(base, prep.sessionId, script, a);
      const tClosed = Date.now();
      const graded = await pollScorecard(base, prep.sessionId, a.gradeTimeoutMs);
      const gradingMs = Date.now() - tClosed;

      const failures: string[] = [];
      let scorecard: GroundedScorecard | undefined;
      if (graded.status === "completed" && graded.evaluation) {
        scorecard = graded.evaluation;
        failures.push(...assertScorecard(metrics, scorecard, prep.rubricAxes));
      } else {
        failures.push(`grading ${graded.status}: ${graded.message || ""}`);
      }
      if (a.lang && metrics.pcmChunks.length) {
        const wav = path.resolve(process.cwd(), `e2e-${a.lang}.wav`);
        writeWav(wav, Buffer.concat(metrics.pcmChunks));
      }
      const r: IterationResult = {
        metrics, rubricAxes: prep.rubricAxes, role: prep.role,
        durationMinutes: prep.durationMinutes, gradingMs, scorecard, failures,
      };
      results.push(r);
      printIteration(i + 1, r, a);
    } catch (e: any) {
      console.error(`\ne2e #${i + 1}  FAIL  ${e.message}`);
      results.push({
        metrics: { errors: [e.message] } as any, rubricAxes: 0, role: "?",
        durationMinutes: 0, gradingMs: 0, failures: [e.message],
      });
    }
  }

  const passed = results.filter((r) => r.failures.length === 0).length;
  const totalDrops = results.reduce((n, r) => n + (r.metrics.drops || 0), 0);
  const ttfas = results.map((r) => r.metrics.ttfaMs).filter((x): x is number => x != null);
  const meanTtfa = ttfas.length ? (ttfas.reduce((s, x) => s + x, 0) / ttfas.length / 1000).toFixed(1) : "—";
  console.log(`\n${passed === results.length ? "PASS" : "FAIL"} ${passed}/${results.length}  total drops ${totalDrops}  mean ttfa ${meanTtfa}s`);
  return passed === results.length ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error("harness crashed:", e);
  process.exit(2);
});
