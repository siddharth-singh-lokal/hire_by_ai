/**
 * Role × level question taxonomy.
 *
 * Gives the question-bank generator concrete guidance on WHAT to ask and HOW,
 * keyed by discipline and seniority. The LLM still generates actual questions
 * from the JD + resume — this steers it so a junior gets fundamentals and
 * debugging questions while a director gets strategy and org-design questions.
 *
 * Sourced from what real interview communities report: Blind, LeetCode Discuss,
 * Glassdoor, Reddit r/cscareerquestions, r/ExperiencedDevs, GeeksforGeeks
 * Discuss, and dozens of "what I was asked at X" threads.
 */

interface LevelBlock {
  level: string;
  test: string;
  askLike: string;
  good: string;
  bad: string;
  avoid: string;
}

interface DisciplineTaxonomy {
  discipline: string;
  preamble: string;
  levels: LevelBlock[];
}

const BACKEND: DisciplineTaxonomy = {
  discipline: "backend",
  preamble:
    "Backend screens test whether someone can build, debug and reason about server-side systems at the right altitude for their level. Junior screens verify they actually wrote the code on their resume; senior screens test decision-making and system thinking.",
  levels: [
    {
      level: "Intern / Junior (SDE-1)",
      test: "CS fundamentals applied to real work (not textbook recall). Basic HTTP/REST/DB understanding. Debugging instinct — what they check first. Whether they actually built what their resume claims. How they handle not knowing something.",
      askLike:
        `"Walk me through how a request flows in your project from client to DB and back." / "Your API is returning 500s after a deploy — what do you check first?" / "You said you used Redis here — what specifically was it doing for you?" / "What do you think this job involves day to day?"`,
      good: "Can explain their own code beyond what a README says. Reasons step by step through an unfamiliar problem. Admits gaps and describes how they'd learn. Can name a specific decision or bug, not just the outcome.",
      bad: "Cannot go deeper than resume bullet points after two follow-ups. Only knows buzzwords ('microservices', 'scalable') without substance. Claims ownership of work they clearly watched from the side. No debugging instinct — jumps to solutions without diagnosing.",
      avoid:
        "System design questions (too senior). Distributed systems concepts. LeetCode-style algorithmic puzzles (this is voice, no shared editor). Architecture decisions they had no power to make. Obscure language trivia.",
    },
    {
      level: "Mid (SDE-2)",
      test: "Ownership stories — did they drive something, or watch it happen? Trade-off thinking — can they explain why NOT to do something? Production debugging depth — the hardest bug, what made it hard. Design at moderate scale. Testing philosophy beyond 'we wrote tests'.",
      askLike:
        `"You reduced latency by 40% — walk me through what was slow, what you tried, and how you measured." / "When would you pick NoSQL over Postgres, and what do you lose?" / "Tell me about the hardest production bug you debugged — what made it hard?" / "Your team wants to rewrite a legacy service. PM wants a feature in 3 weeks. What do you recommend?"`,
      good: "Explains decisions they rejected and why. Owns failures without deflection. Can discuss trade-offs that reach beyond their own code. Has a testing philosophy, not just test coverage. Measures impact, not just ships code.",
      bad: "Can only describe what things do, never why they were chosen. Vague on impact ('improved performance' with no numbers or approach). No ownership stories — everything was 'the team'. Treats every technology choice as obvious.",
      avoid:
        "Architecture-astronaut questions (staff-level scale). Treating every question as a resume walk-through — mid-levels need standalone technical questions too. Definitions and trivia ('what is ACID?').",
    },
    {
      level: "Senior (SDE-3)",
      test: "Cross-team technical decisions and their consequences. Architecture reasoning at real scale — not diagrams, but trade-offs and failure modes. Mentoring and technical influence. Debugging complex distributed issues. Whether they have OPINIONS backed by experience, not just knowledge.",
      askLike:
        `"What's the most impactful technical decision you've made that affected teams beyond your own?" / "Product says users are complaining search is slow. No ticket, no metrics. What are your first 48 hours?" / "Explain a distributed systems problem you hit in production — consensus, data loss, whatever — and how you resolved it." / "How do you handle a code review where a junior took a fundamentally wrong approach but spent a week on it?"`,
      good: "Has technical opinions and can defend them with experience. Thinks about failure modes before they happen. Can describe influence beyond their own code (mentoring, architecture decisions, cross-team alignment). Reasons about systems, not just services.",
      bad: "Only has individual-contributor stories at a mid-level scope. Cannot think holistically about systems (only their service). No evidence of making others better. Treats every problem as a coding problem.",
      avoid:
        "Trivia and definitions (insulting at this level). Basic coding questions. Asking them to recite things they could look up in 30 seconds. Resume walk-throughs without depth.",
    },
    {
      level: "Staff / Tech Lead",
      test: "Technical vision and roadmap thinking. Multiplier effect — how they make teams more productive, not just themselves. Incident leadership under pressure. Scope management and saying no. The gap between 'good engineer' and 'engineering leader'.",
      askLike:
        `"You inherit a monolith at 50 RPS. Business wants 500 RPS in 6 months. What is your plan, and what do you NOT do?" / "How do you make code reviews actually useful instead of rubber stamps?" / "Walk me through the last P1 you led — what went well, what would you change?" / "How do you decide what gets into a sprint vs the backlog? Give me a real example where you cut scope."`,
      good: "Thinks in terms of team output, not personal output. Has a point of view on architecture AND can explain why alternatives were worse. Can describe how they changed a team's engineering culture. Balances technical excellence with delivery pragmatism.",
      bad: "Only talks about their own code contributions. Cannot articulate how they make others better. Over-indexes on technical perfection at the expense of delivery. Cannot describe any scope they intentionally cut.",
      avoid:
        "Coding-level questions (wrong altitude). Treating them like a senior IC. Asking about individual contributions only.",
    },
  ],
};

const FRONTEND: DisciplineTaxonomy = {
  discipline: "frontend",
  preamble:
    "Frontend screens test whether someone can build for real users on real devices. The signal is not 'do they know React' but 'do they think about what happens on the other side of the screen' — performance on bad connections, accessibility, internationalisation, and the gap between a component that works and one that works well.",
  levels: [
    {
      level: "Intern / Junior",
      test: "HTML/CSS/JS fundamentals as applied to real projects, not trivia. Component thinking — how they break a UI into pieces. Basic accessibility awareness. Responsive design instinct. Whether they actually built what they claim.",
      askLike:
        `"Walk me through the component structure of your project — how did you decide what became a component?" / "This page loads slowly on a 3G connection — where would you start looking?" / "You said you used Next.js — what specifically did SSR buy you in this project?" / "A user reports the form doesn't work on their phone. You can't reproduce it. What do you do?"`,
      good: "Thinks about the user's device and connection, not just their dev machine. Can explain their component structure and why. Understands that CSS is real engineering, not decoration. Can describe a bug they found and how they debugged it in the browser.",
      bad: "Has only ever tested on localhost with fast internet. Cannot explain their own project's structure. Treats CSS as something they copy-paste from Stack Overflow. No concept of why something might work differently across browsers.",
      avoid:
        "System design. Backend concepts (databases, APIs). Algorithm puzzles. Advanced framework internals (SSR hydration edge cases, reconciliation algorithms).",
    },
    {
      level: "Mid",
      test: "Performance diagnosis — where the time goes and what to do about it. State management decisions and trade-offs. Testing strategy for UI. Cross-browser/device debugging. Build tooling awareness. Accessibility beyond checkboxes.",
      askLike:
        `"This page's Lighthouse score is 35. Walk me through how you'd diagnose and fix it." / "How did you decide on your state management approach? What did you reject and why?" / "A component works in Chrome but breaks in Safari — how do you debug it?" / "How do you test a complex form with multiple validation states?"`,
      good: "Can reason about bundle size, rendering pipeline, and paint cost. Understands the real trade-offs between state management approaches (not just 'Redux is standard'). Has debugged something cross-browser and can describe the process. Tests the user's experience, not just their code.",
      bad: "Treats performance as 'add lazy loading everywhere'. Cannot explain why they chose their tools beyond 'the team used it'. Has never opened browser DevTools Performance tab. Treats accessibility as a checkbox exercise.",
      avoid:
        "Backend architecture questions. Low-level browser engine internals (unless they claim expertise). Generic 'tell me about yourself' padding.",
    },
    {
      level: "Senior",
      test: "Frontend architecture for large applications. Design system thinking — building for reuse across teams. Build pipeline and developer experience. Accessibility at organisational scale. Mentoring and technical influence. Framework-level decision making.",
      askLike:
        `"How would you architect the frontend for a product that's split across three teams?" / "Walk me through building or adopting a design system — where do most fail?" / "How do you balance developer experience with user experience when they conflict?" / "What's your approach to frontend testing at scale — where do you draw the line on what to test?"`,
      good: "Thinks about developer experience AND user experience as equal concerns. Can make and defend framework-level decisions. Has built something used by other teams and can describe the API design trade-offs. Thinks about the build pipeline as a product for their team.",
      bad: "Only has single-app, single-team experience scaled up. Cannot discuss architecture beyond component structure. Treats testing as something that happens after the code is written. No evidence of influencing how other engineers work.",
      avoid:
        "Basic CSS/JS questions (insulting). Algorithm puzzles. Backend system design. Asking a senior to 'walk through a simple component'.",
    },
    {
      level: "Staff / Lead",
      test: "Frontend platform strategy across products. Performance culture — making the whole org care about web vitals, not just the frontend team. Cross-team standards and migration strategy. Build infrastructure as a platform. Technical vision for the web surface.",
      askLike:
        `"Three product teams each picked a different framework. You're now the staff frontend engineer. What's your first quarter look like?" / "How do you create a performance culture in an org where PMs don't care about web vitals?" / "Walk me through a large-scale migration you led — not the tech, but how you got buy-in and managed the long tail."`,
      good: "Thinks about the frontend as an organisational capability, not just code. Can describe influence across teams without authority. Has led a migration or platform initiative and can talk about the human side. Balances ideal architecture with migration cost.",
      bad: "Only thinks in terms of their own code or their own team. Cannot describe organisational influence. Over-indexes on technical purity without pragmatism.",
      avoid:
        "Coding-level questions. Single-component problems. Individual-contributor-scope discussions.",
    },
  ],
};

const MOBILE: DisciplineTaxonomy = {
  discipline: "mobile",
  preamble:
    "Mobile screens test whether someone builds for the device in the user's hand — battery, memory, network, and the app store review process are all constraints that don't exist on the web. The platforms (iOS/Android) have strong opinions, and a good mobile engineer works with them rather than fighting them.",
  levels: [
    {
      level: "Intern / Junior",
      test: "Platform fundamentals (lifecycle, navigation, storage). Whether they actually built what they claim — can they explain their app's architecture? Basic UI implementation. How they handle device constraints (offline, slow network). Debugging on a real device.",
      askLike:
        `"Walk me through your app's architecture — how did you decide what goes where?" / "A user reports your app crashes when they rotate the screen. What's likely happening?" / "You said you used Retrofit/Alamofire — what does it do for you that raw HTTP doesn't?" / "How did you handle the case where the user has no internet?"`,
      good: "Understands the activity/view controller lifecycle from building with it, not from a tutorial. Can explain their own app's architecture. Has tested on a real device, not just the emulator. Thinks about offline as a normal state, not an edge case.",
      bad: "Cannot explain the lifecycle beyond memorised stages. Has only run their app on the emulator. Treats 'no internet' as an error rather than a design constraint. Copy-pasted architecture patterns without understanding them.",
      avoid:
        "Advanced architecture patterns (VIPER, MVI) for juniors. Cross-platform framework internals. Backend system design. Platform politics (iOS vs Android debates).",
    },
    {
      level: "Mid",
      test: "App architecture decisions and trade-offs. Performance profiling (memory, battery, startup time). Handling complex UI state. Background work and sync strategy. App store submission and review process. Testing strategy for mobile.",
      askLike:
        `"Your app's startup time went from 1s to 4s over six months. How do you diagnose that?" / "How did you decide between MVVM and your architecture pattern? What did you reject?" / "Walk me through your approach to background sync — what happens when it fails halfway?" / "An app update got rejected by the store. Walk me through how you handled it."`,
      good: "Can profile and improve app performance with specific tools (Instruments, Android Profiler). Understands the trade-offs of their architecture pattern. Has dealt with real app store review issues. Thinks about battery and memory as first-class constraints.",
      bad: "Cannot name a profiling tool or describe how they'd find a memory leak. Chose their architecture because 'it's standard' with no trade-off reasoning. Has never dealt with app store review. Treats the device as a small computer rather than a constrained platform.",
      avoid:
        "Backend system design. Cross-platform framework comparison debates. Algorithm puzzles.",
    },
    {
      level: "Senior",
      test: "Platform-level architecture for large apps. Modularisation and build time management. SDK/library design for other teams. Performance at scale. Release strategy and feature flags. Mentoring and mobile-specific code review.",
      askLike:
        `"Your app's codebase has grown to 500K lines and build times are 8 minutes. What's your approach?" / "How would you design a shared SDK that three different apps consume?" / "Walk me through your release process — how do you handle a critical bug found after submission?" / "How do you ensure consistent quality across a mobile team of 8 engineers?"`,
      good: "Thinks about build times, modularisation, and developer experience. Can design for SDK consumers, not just app builders. Has a release strategy that handles reality (rollbacks, phased rollouts). Influences the mobile team's practices and standards.",
      bad: "Only has experience in a single app codebase. Cannot think about modularisation or build systems. No release management experience. Individual contributor only, no influence on team practices.",
      avoid:
        "Basic platform questions. Coding exercises. Individual feature implementation.",
    },
    {
      level: "Staff / Lead",
      test: "Mobile platform strategy. Cross-platform vs native decision-making. Mobile infrastructure (CI/CD, analytics, crash reporting). Org-level mobile architecture. Technical vision for the mobile surface.",
      askLike:
        `"The company wants to support iOS, Android, and web from one codebase. Walk me through how you'd evaluate that." / "How do you decide when to invest in mobile infrastructure vs shipping features?" / "Walk me through building a mobile CI pipeline that doesn't make engineers wait 30 minutes per PR."`,
      good: "Makes cross-platform decisions based on org context, not ideology. Thinks about mobile infrastructure as a product for the engineering team. Has led a significant architectural shift and can describe the human side.",
      bad: "Religious about native vs cross-platform without contextual reasoning. Cannot think beyond a single app. No platform strategy experience.",
      avoid:
        "Individual feature questions. Coding exercises. Basic platform fundamentals.",
    },
  ],
};

const DEVOPS: DisciplineTaxonomy = {
  discipline: "devops",
  preamble:
    "DevOps/SRE screens test whether someone can keep systems running AND make developers more productive. The signal is not 'can they write a Terraform file' but 'do they understand what breaks at 3am and how to make it not break again'. Incident stories and automation instinct matter more than tool lists.",
  levels: [
    {
      level: "Junior",
      test: "Linux fundamentals applied to real debugging. Networking basics (DNS, HTTP, TCP/IP) as they relate to real problems. CI/CD concepts — what a pipeline does and why. Basic cloud services understanding. Scripting instinct.",
      askLike:
        `"A deploy went out and the service is returning 502s. Walk me through your first five minutes." / "Explain what happens at the network level when a user hits your load balancer." / "You said you set up the CI pipeline — what does it actually do, and what would you change about it?" / "A disk is filling up on a production server. How do you diagnose what's consuming the space?"`,
      good: "Has actually SSH'd into a server and debugged something. Understands the request path from DNS to response. Can write a script to automate something they've done manually. Thinks about 'what happens when this breaks' not just 'how to set it up'.",
      bad: "Has only clicked buttons in a cloud console. Cannot explain basic networking. Treats CI/CD as magic. No scripting ability — everything is manual.",
      avoid:
        "Kubernetes internals. Advanced distributed systems. Chaos engineering. Architecture-level platform design.",
    },
    {
      level: "Mid",
      test: "Infrastructure as code — not just syntax, but managing state and drift. Monitoring and alerting design — what to alert on and why. Incident response process. Container orchestration in practice. Cost optimization awareness. Automation philosophy.",
      askLike:
        `"You're designing the monitoring for a new service. What do you alert on, what do you dashboard, and what do you log?" / "Walk me through an incident you responded to — how did you diagnose it, and what changed afterwards?" / "Your Terraform state has drifted from reality. How do you detect and fix it?" / "The cloud bill jumped 40% this month. Walk me through investigating it."`,
      good: "Designs alerts based on symptoms (user impact) not causes (CPU spikes). Has real incident stories with post-incident improvements. Understands Terraform state management beyond 'terraform apply'. Can reason about cost as an engineering constraint.",
      bad: "Alerts on every metric threshold (100 alerts, all ignored). Has never written a post-mortem or changed anything after an incident. Treats IaC as 'we use Terraform' with no state management understanding. Cannot connect infrastructure decisions to cost.",
      avoid:
        "Platform architecture strategy (staff level). Org-wide observability design. Build-vs-buy platform decisions.",
    },
    {
      level: "Senior",
      test: "Platform architecture for reliability at scale. SLO/SLI design and error budget management. Capacity planning. Disaster recovery and chaos engineering. Organisation-wide observability strategy. On-call culture and incident management process.",
      askLike:
        `"How would you design for 99.99% availability? What would you trade off for 99.9%?" / "Walk me through your SLO framework — how do you set targets, and what happens when you breach the error budget?" / "The org's on-call is burning people out. How do you fix it?" / "Walk me through your disaster recovery plan — not the docs, the last time you tested it."`,
      good: "Reasons about reliability in terms of user impact, not infrastructure metrics. Has designed and used SLOs to make trade-off decisions. Has actually run a disaster recovery test (not just planned one). Thinks about on-call as a human problem, not just a technical one.",
      bad: "Conflates uptime with availability. Cannot reason about trade-offs between reliability and velocity. Has never tested DR. Treats on-call as 'someone has to carry the pager'.",
      avoid:
        "Basic tool usage questions. Single-service debugging. Coding exercises.",
    },
    {
      level: "Staff / Lead",
      test: "Platform team strategy — what to build, what to buy, what to leave alone. Developer experience as a product. Build-vs-buy decisions at organisational scale. Migrations and decommissions. Cross-team enablement without gatekeeping.",
      askLike:
        `"How do you decide what your platform team builds next year vs what you buy?" / "50 engineers are deploying to your platform. How do you make their experience good without becoming a bottleneck?" / "Walk me through a large migration you led — the hardest part was probably not the technology."`,
      good: "Treats the platform as a product with internal customers. Can describe a migration in terms of the human coordination, not just the technical plan. Makes build-vs-buy decisions based on strategic value, not just cost. Enables teams without gatekeeping.",
      bad: "Treats the platform as a gatekeeper role. Cannot describe influence across teams. Optimises for technical elegance over developer productivity.",
      avoid:
        "Individual tool configuration. Single-incident debugging. Basic infrastructure concepts.",
    },
  ],
};

const DATA: DisciplineTaxonomy = {
  discipline: "data",
  preamble:
    "Data/Analytics screens test whether someone can turn messy information into decisions. The signal is not 'can they write SQL' but 'do they know what question to ask, how to trust the answer, and how to communicate it to someone who'll act on it'. Rigour and stakeholder instinct matter as much as technical chops.",
  levels: [
    {
      level: "Junior / Analyst",
      test: "SQL proficiency applied to real problems (not textbook joins). Basic statistics — can they avoid common pitfalls (correlation ≠ causation, Simpson's paradox)? Dashboard design — do they think about who reads it? Data quality awareness. Stakeholder communication.",
      askLike:
        `"A product manager says signups dropped 20% last week. Walk me through how you'd investigate." / "You built this dashboard — who reads it, and how did that shape what you put on it?" / "Walk me through a time your data told a different story than what the team expected. How did you handle it?" / "You found a metric that looks too good to be true. What do you check?"`,
      good: "Asks clarifying questions before diving into data. Thinks about who will use their analysis and what decision it serves. Checks for data quality issues before drawing conclusions. Can explain statistical concepts in plain language.",
      bad: "Dives straight into SQL without understanding the question. Builds dashboards nobody reads. Trusts data at face value with no quality checks. Cannot communicate findings to non-technical people.",
      avoid:
        "Advanced statistical methods. Data engineering pipeline design. Machine learning. Causal inference methodology.",
    },
    {
      level: "Mid",
      test: "Experiment design (A/B tests) and pitfalls — sample size, novelty effects, metric selection. Complex data modelling. Stakeholder management — navigating disagreement about what the data says. Pipeline understanding. Segmentation and cohort analysis.",
      askLike:
        `"You're designing an A/B test for a new feature. Walk me through your approach — metric selection, sample size, duration, guardrails." / "This A/B test shows a positive result for the headline metric but a negative one for retention. What do you tell the PM?" / "Walk me through a time you had to tell a stakeholder their pet project wasn't working according to the data." / "How do you build a metrics framework for a new product area?"`,
      good: "Designs experiments with clear hypotheses and success criteria before running them. Knows when to trust and when to distrust an A/B test result. Can navigate stakeholder disagreement with data AND empathy. Thinks about metrics as a system, not individual numbers.",
      bad: "Runs A/B tests without clear hypotheses. Cherry-picks results that confirm the stakeholder's preference. Cannot handle conflicting metrics. Treats every data question as a SQL problem.",
      avoid:
        "Advanced ML engineering. Data infrastructure design (staff level). Highly theoretical statistics.",
    },
    {
      level: "Senior",
      test: "Data strategy — what should the organisation measure and why? Metrics framework design from scratch. Cross-functional influence — making data part of how decisions happen, not an afterthought. Data governance and quality at scale. Team mentoring.",
      askLike:
        `"You join a company where metrics are ad-hoc — every team defines 'active user' differently. How do you fix that?" / "Walk me through building a metrics framework for a new business line — where do you start?" / "How do you create a data-informed culture in an org where decisions are currently made by HiPPO?" / "What's your approach to data quality — not the tooling, the organisational problem?"`,
      good: "Thinks about data as an organisational capability, not just an analytical function. Can build consensus around metric definitions. Influences product and engineering decisions, not just reports on them. Treats data quality as a process problem, not a pipeline problem.",
      bad: "Only thinks in terms of dashboards and reports. Cannot influence non-data stakeholders. Treats data governance as someone else's problem. No evidence of shaping how the org uses data.",
      avoid:
        "Basic SQL. Individual analysis tasks. Tool-specific questions.",
    },
    {
      level: "Staff / Lead",
      test: "Analytics org design. Data platform strategy. Executive communication — translating data into business decisions at the C-level. Cross-org data governance. Building and scaling an analytics team.",
      askLike:
        `"How do you structure an analytics org for a company with five product lines?" / "Walk me through how you communicate a data-driven recommendation to the CEO that contradicts their intuition." / "How do you decide what to build in-house vs buy for your data stack?"`,
      good: "Designs analytics orgs for the business they serve. Can communicate data to any audience. Makes strategic platform decisions. Has built or scaled a data team.",
      bad: "Only thinks in terms of the data stack, not the business. Cannot communicate to executives. Has never built a team.",
      avoid:
        "Individual analysis. Basic statistical methods. Single-tool proficiency.",
    },
  ],
};

const PRODUCT: DisciplineTaxonomy = {
  discipline: "product",
  preamble:
    "Product management screens test whether someone can turn ambiguity into a plan that a team can execute on. The signal is not 'do they know the frameworks' but 'can they make a good decision with incomplete information and get the right people aligned'. Judgment under uncertainty is the whole job.",
  levels: [
    {
      level: "Associate / Junior PM",
      test: "Feature-level thinking — can they scope a feature, prioritise within it, and explain what they'd cut? User empathy — do they think from the user's perspective naturally? Spec writing and engineer collaboration. Basic metrics awareness. Handling feedback and ambiguity.",
      askLike:
        `"You're building a notifications feature. How would you scope the v1?" / "How did you prioritise the requirements for your last project? Walk me through a specific trade-off." / "Your engineering lead says the feature will take 3x longer than you estimated. What do you do?" / "Walk me through how you work with engineers — what does a good handoff look like?"`,
      good: "Scopes aggressively — can explain what they'd cut and why. Thinks about the user unprompted, not just the feature. Works WITH engineers, not just hands specs over the wall. Can handle 'we can't build that' without panic.",
      bad: "Cannot prioritise — everything is P0. Describes features without mentioning the user. Treats engineers as ticket-takers. Falls apart when the plan changes.",
      avoid:
        "Strategy and vision questions (too senior). Market analysis. P&L and revenue modelling. Framework name-dropping (Jobs to Be Done, RICE — anyone can memorise these).",
    },
    {
      level: "Mid PM",
      test: "Strategy-to-execution — can they connect a business goal to a feature roadmap? Stakeholder management under real conflict. Experiment design and metrics-driven decisions. Go-to-market thinking. Saying no — when and how they killed something.",
      askLike:
        `"Walk me through a time you said no to a stakeholder who outranked you. What happened?" / "How do you decide what NOT to build this quarter?" / "You launched a feature and usage is 30% of what you expected. Walk me through your next two weeks." / "Your CEO and your Head of Engineering disagree on the product direction. You report to both. How do you handle it?"`,
      good: "Has killed something and can explain why. Makes decisions with data but doesn't hide behind it. Can manage stakeholders with empathy AND firmness. Connects features to business outcomes, not just user stories.",
      bad: "Has never said no to anything. Hides behind data ('the A/B test said...') to avoid ownership. Cannot describe stakeholder conflict they navigated. Roadmaps are wish lists with no trade-offs.",
      avoid:
        "Coding or technical implementation details. Basic framework definitions. 'Design a product for X' whiteboard exercises (this is voice).",
    },
    {
      level: "Senior PM",
      test: "Product vision and the conviction to back it. Zero-to-one thinking — building something new vs optimising something existing. Market analysis and competitive positioning. Cross-team influence without authority. Whether they think in terms of outcomes, not output.",
      askLike:
        `"Walk me through a zero-to-one product you built. How did you build conviction it was worth doing?" / "How do you evaluate a new market opportunity? Walk me through a real example." / "How do you get three teams aligned on a shared goal when none of them report to you?" / "What's a product bet you made that failed? What would you do differently?"`,
      good: "Thinks in outcomes, not features. Has built conviction for something risky and can describe how. Can influence without authority across teams. Has a product failure they own and learned from.",
      bad: "Thinks in features and launches, not outcomes. Cannot describe a product bet they took. Only succeeds when they have authority. No product failures — which means they never took a risk.",
      avoid:
        "Execution-level details (scoping, spec writing). Basic PM frameworks. Technical implementation.",
    },
    {
      level: "Lead / Director / VP",
      test: "Product strategy at the portfolio level. Org design for product teams. Board/investor communication. Resource allocation across bets. Building and developing PM talent.",
      askLike:
        `"You're given three product areas and have to shut down one to fund a new bet. Walk me through that decision." / "How do you structure product teams for a company with five products?" / "Walk me through how you present a product strategy to the board — what do they need to hear vs what they want to hear?"`,
      good: "Makes portfolio-level trade-offs, not just feature-level. Can structure product teams for the business. Communicates strategy to any audience. Has developed PMs and can describe how.",
      bad: "Still thinks feature-by-feature at this altitude. Cannot describe org design. Has never presented to a board or investors. Sees PM development as 'hiring good people'.",
      avoid:
        "Execution detail. Individual feature design. Basic PM skills.",
    },
  ],
};

const DESIGN: DisciplineTaxonomy = {
  discipline: "design",
  preamble:
    "Design screens test whether someone can make good design decisions under real constraints — time, tech, and users who aren't like them. The signal is not 'is their portfolio pretty' but 'do they understand why they made the choices they did and how those choices affected real users'. Process matters as much as output.",
  levels: [
    {
      level: "Junior",
      test: "Design process — do they have one, or do they just start in Figma? User empathy — can they describe who they designed for? Handling feedback and iteration. Visual fundamentals. Tool proficiency applied to real work, not tutorials.",
      askLike:
        `"Walk me through your design process for [portfolio piece] — from brief to final." / "How did you decide on the layout? What alternatives did you explore?" / "You got feedback from the PM that the design doesn't work. What did you do?" / "How did you know this design was working for users?"`,
      good: "Has a process, even if informal. Can articulate WHY they made design choices, not just WHAT. Handles feedback constructively. Thinks about the user from the start, not as an afterthought.",
      bad: "Jumps straight into high-fidelity without exploring. Cannot explain their decisions beyond aesthetics. Gets defensive about feedback. Has never validated a design with real users.",
      avoid:
        "Design system architecture. Org-level design strategy. Advanced UX research methodology. Asking them to design something live on a voice call.",
    },
    {
      level: "Mid",
      test: "User research methodology — do they validate before building, and how? Design systems contribution — working within constraints and improving them. Cross-functional collaboration depth. Accessibility as a design constraint. Iteration and measuring design impact.",
      askLike:
        `"Walk me through how you validate a design before engineering builds it." / "You're working within an existing design system but your feature needs something it doesn't have. What do you do?" / "How do you communicate design trade-offs to an engineer who says 'this is too hard to build'?" / "Walk me through a design you iterated on after launch based on user behaviour."`,
      good: "Validates designs before they're built. Works within design system constraints AND improves them. Collaborates with engineers as equals, not just hands off mockups. Uses data to iterate, not just intuition.",
      bad: "Designs in isolation and throws over the wall. Treats the design system as restrictive rather than collaborative. Cannot navigate technical constraints. Only iterates based on stakeholder feedback, never user data.",
      avoid:
        "Basic tool proficiency. Visual fundamentals. Design system architecture (senior). Org design.",
    },
    {
      level: "Senior",
      test: "Design strategy — connecting design decisions to business outcomes. Design system architecture and scaling design across teams. Mentoring and raising the design bar. Cross-functional influence at the leadership level. Accessibility and internationalisation as org-level concerns.",
      askLike:
        `"How do you build or evolve a design system for a multi-product company?" / "Walk me through a time you influenced a product direction through design — not just made it look better." / "How do you ensure design quality across a team of 6 designers with different strengths?" / "What's the hardest design trade-off you've made, and how did you decide?"`,
      good: "Connects design to business outcomes. Can build and scale design systems. Influences product direction, not just product aesthetics. Mentors other designers with specific, actionable feedback.",
      bad: "Only thinks at the feature level. Cannot describe design's business impact. Has never mentored or scaled a design practice. Treats design systems as a component library.",
      avoid:
        "Individual feature design tasks. Basic UX principles. Tool-specific questions.",
    },
    {
      level: "Lead / Head of Design",
      test: "Design org vision and culture. Hiring and developing designers. Design operations. Executive communication. Design's seat at the strategy table.",
      askLike:
        `"How do you structure a design team for a company with multiple products?" / "Walk me through how you advocate for design investment to a CEO who sees it as 'making things pretty'." / "How do you build a design culture where critique is productive, not political?"`,
      good: "Builds design orgs, not just design. Can advocate for design at the executive level. Creates a healthy critique culture. Has hired and developed designers and can describe how.",
      bad: "Still thinks as an individual designer at this altitude. Cannot communicate design value to business leaders. Has never built a team.",
      avoid:
        "Pixel-level craft questions. Individual project reviews. Tool proficiency.",
    },
  ],
};

const MARKETING: DisciplineTaxonomy = {
  discipline: "marketing",
  preamble:
    "Marketing screens test whether someone understands how to reach the right people with the right message and measure whether it worked. The signal is not 'do they know marketing jargon' but 'can they connect spend to outcomes, adapt when a channel stops working, and explain what they'd do differently with the same budget'. Data and creativity in equal measure.",
  levels: [
    {
      level: "Junior / Executive",
      test: "Channel understanding — do they know the difference between paid/organic/owned, and what each is actually good at? Campaign execution — can they describe one end to end? Basic analytics — do they measure what they do? Copywriting and communication instinct. Tool proficiency applied to real work.",
      askLike:
        `"Walk me through a campaign you ran end to end — what was the goal, what did you do, and how did you know it worked?" / "You have ₹50K/month budget for a new product launch. How would you allocate it?" / "Your social media post went viral but brought zero conversions. What happened and what would you change?" / "Walk me through how you write copy for [audience] — what's your process?"`,
      good: "Can connect campaigns to business outcomes (not just impressions). Thinks about the audience before the channel. Measures what they do and can describe what worked and what didn't. Can write copy that sounds like a human, not a marketing textbook.",
      bad: "Measures vanity metrics only (followers, impressions). Cannot connect any campaign to a business result. Treats every channel the same. Copy sounds like it was generated by filling in a template.",
      avoid:
        "Strategy and brand architecture. Budget optimisation at scale. Team leadership. Advanced attribution modelling.",
    },
    {
      level: "Mid",
      test: "Growth strategy and channel optimisation. Budget allocation based on data, not habit. A/B testing for marketing (landing pages, copy, targeting). User acquisition funnels and where they break. Brand voice and consistency. Competitive positioning awareness.",
      askLike:
        `"Your best-performing channel's CPA just doubled. Walk me through your next two weeks." / "How do you decide between investing more in a working channel vs testing a new one?" / "Walk me through optimising a conversion funnel — where do you look, what do you change, how do you measure?" / "You need to build brand awareness in a market where nobody knows you. What's your approach?"`,
      good: "Makes budget decisions based on data, not 'we've always done it this way'. Can optimise a funnel with specific, measurable changes. Balances short-term acquisition with long-term brand building. Has tested something, found it didn't work, and changed approach.",
      bad: "Doubles down on what's always worked without testing alternatives. Cannot diagnose a funnel beyond 'we need more traffic'. Only thinks in paid media, ignores organic and brand. Has never killed a campaign that wasn't working.",
      avoid:
        "CMO-level strategy. Brand repositioning. Team building. Board-level communication.",
    },
    {
      level: "Senior",
      test: "Marketing strategy that connects to business outcomes. Team leadership and developing marketers. Brand building at scale. P&L awareness — marketing as an investment, not a cost. Cross-functional influence (product, sales, customer success).",
      askLike:
        `"Walk me through building a marketing strategy for a new market from scratch." / "How do you measure marketing's contribution to revenue — and how do you communicate it to the CFO?" / "Your brand perception is 'cheap' but the product has moved upmarket. How do you reposition?" / "How do you build a marketing team where people own outcomes, not just activities?"`,
      good: "Connects marketing to revenue and can prove it. Thinks about brand and performance as complementary, not competing. Can influence product and sales teams. Builds teams that own outcomes.",
      bad: "Only thinks in campaigns, not strategy. Cannot connect marketing spend to revenue. Sees brand and performance marketing as unrelated. Manages activities, not outcomes.",
      avoid:
        "Execution-level campaign details. Channel-specific tactics. Basic marketing concepts.",
    },
    {
      level: "Lead / Director / CMO",
      test: "Marketing as a business function — budget, team, strategy, board. Org design for marketing teams. Brand architecture and positioning strategy. Executive communication. Building marketing as a competitive advantage.",
      askLike:
        `"How do you structure a marketing org for a company entering three new markets simultaneously?" / "Walk me through presenting a marketing strategy and budget to the board." / "How do you decide when to in-house a capability vs use an agency?"`,
      good: "Thinks about marketing as a strategic business function. Can structure teams and budgets for the business. Communicates to the board in their language. Makes in-house vs agency decisions strategically.",
      bad: "Still thinks in campaigns at this altitude. Cannot structure a marketing org. Has never managed a significant marketing budget.",
      avoid:
        "Individual campaign execution. Channel-specific optimisation. Basic analytics.",
    },
  ],
};

const SUPPORT: DisciplineTaxonomy = {
  discipline: "support",
  preamble:
    "Support/care screens test whether someone can stay calm under pressure, communicate with empathy, and think in systems — not just solve the current ticket but recognise patterns and prevent the next hundred. For more senior roles, the shift is from handling contacts to designing the system that handles contacts.",
  levels: [
    {
      level: "Junior / Executive",
      test: "Empathy and active listening — do they hear what the user is actually saying? Escalation judgment — when to solve it vs when to escalate. Composure under pressure — can they stay calm when someone is angry? Communication clarity in writing and speech. Genuine curiosity about why problems happen.",
      askLike:
        `"A user calls furious because they were charged twice. Walk me through how you handle that call." / "How do you decide when to try solving something yourself vs escalating to a senior?" / "Walk me through a time you helped someone who was really upset. What did you do, and how did you know it worked?" / "You notice three users reported the same bug this week. What do you do?"`,
      good: "Listens before fixing. Stays calm when describing pressure situations. Can explain their escalation reasoning. Notices patterns, not just individual cases. Treats every user as a real person, not a ticket.",
      bad: "Jumps to solutions before understanding the problem. Gets flustered describing pressure. No escalation judgment — either escalates everything or nothing. Treats support as a queue to clear.",
      avoid:
        "Process design questions (too senior). Metrics and KPI management. Team leadership. Technical debugging depth.",
    },
    {
      level: "Mid / Senior Agent / QA",
      test: "Process improvement — finding and fixing the system, not just the symptom. Quality assurance — what does good support look like, and how do you maintain it? Training others — can they make a new hire effective? Pattern recognition at scale. Cross-functional advocacy — taking what support sees back to product and engineering.",
      askLike:
        `"You notice 30% of your contacts this month are about the same issue. How do you fix that — not the issue, the fact that it keeps happening?" / "Walk me through training a new team member — how do you make them effective in their first week?" / "How do you define 'quality' in support, and how do you measure it?" / "You have strong evidence that a product decision is causing user pain. How do you get the product team to care?"`,
      good: "Thinks in systems — resolves categories of problems, not just individual ones. Can train effectively and explain their approach. Measures quality beyond CSAT. Advocates for users to product and engineering teams.",
      bad: "Only resolves individual tickets, never the pattern. Cannot train others beyond 'shadow me'. Defines quality as CSAT only. Sees support as separate from product, not a feedback loop.",
      avoid:
        "Support org strategy (director level). Vendor management. Executive reporting.",
    },
    {
      level: "Senior / Team Lead",
      test: "Support operations strategy. CSAT/NPS improvement beyond the obvious. Cross-functional advocacy at the leadership level. Tooling decisions and support infrastructure. Team management including performance and burnout.",
      askLike:
        `"CSAT is 72% and the CEO wants 85%. Walk me through your approach — not just 'hire more people'." / "How do you prevent burnout on a team that handles 200 angry contacts per day?" / "Walk me through choosing a new support tool — what mattered and what didn't?" / "How do you build a relationship with the product team where support's input actually shapes the roadmap?"`,
      good: "Thinks about support as a system — channels, routing, tooling, team, product feedback loop. Addresses burnout proactively. Can influence product decisions. Measures things beyond CSAT.",
      bad: "Only solution is 'hire more people'. Treats burnout as inevitable. No product influence. Sees support tools as someone else's decision.",
      avoid:
        "Individual ticket resolution. Basic escalation decisions. Agent-level skills.",
    },
    {
      level: "Director / Head of Support",
      test: "Support org design — channels, tiers, self-serve, automation. Vendor management for outsourced support. Executive reporting — making the board care about support as a strategic function. Channel strategy (chat vs phone vs email vs self-serve). Building support as a competitive advantage.",
      askLike:
        `"How do you decide what to automate vs what needs a human?" / "Walk me through building a support org from 5 to 50 agents." / "How do you present support metrics to the board in a way that drives investment?" / "Your outsourced support vendor's quality is dropping. What do you do?"`,
      good: "Designs support orgs, not just manages them. Can make automation decisions that improve (not degrade) the user experience. Communicates support's value to executives. Manages vendors as strategic partners.",
      bad: "Only thinks about headcount and coverage. Automates everything regardless of user impact. Cannot communicate support's business value. Treats vendors as cost centres.",
      avoid:
        "Individual escalations. Agent-level coaching. Basic tool usage.",
    },
  ],
};

const FIELD: DisciplineTaxonomy = {
  discipline: "field",
  preamble:
    "Field sales/operations screens test whether someone can build relationships, manage a territory, and deliver results on the ground. The signal is not 'do they know sales theory' but 'have they knocked on doors, heard no, and figured out how to make it work anyway'. Resilience, planning, and street-smart problem-solving matter more than formal training.",
  levels: [
    {
      level: "Junior / Field Executive",
      test: "Daily planning and route management. Communication skills — can they build rapport with small business owners? Objection handling — how they respond to 'no'. Resilience — the job is rejection-heavy, and quitting is the main failure mode. Basic numeracy — do they understand their own targets?",
      askLike:
        `"Walk me through your typical day — how do you plan your route and decide who to visit?" / "A kirana store owner says they're not interested. Walk me through what you do." / "You're behind on your weekly target by Thursday. What changes?" / "What do you think makes someone successful in a field role vs what makes them quit?"`,
      good: "Plans their day rather than wandering. Can handle rejection without taking it personally. Adapts their approach for different store owners. Has realistic expectations about the job. Can explain their targets and what drives them.",
      bad: "No daily plan — visits whoever is closest. Takes rejection personally and avoids follow-up. Cannot explain their own targets. Unrealistic expectations about what the job involves.",
      avoid:
        "Strategy and market expansion. Team management. P&L analysis. Territory design at the regional level.",
    },
    {
      level: "Mid / Senior Field Executive",
      test: "Territory optimisation — covering more ground efficiently. Relationship depth — do retailers trust them? Training new field staff. Market intelligence — do they notice and report competitive activity? Target planning and self-management.",
      askLike:
        `"You manage 80 outlets. Walk me through how you segment them and decide visit frequency." / "How do you train a new field executive in their first week? What do you teach them first?" / "A competitor launched a better deal in your territory. What do you do — this week and this month?" / "Walk me through how you hit a target that seemed impossible. What specifically did you change?"`,
      good: "Segments outlets by value and manages time accordingly. Has trained someone and can explain their approach. Notices competitive activity and acts on it. Can describe specifically what they changed to hit a tough target — not just 'worked harder'.",
      bad: "Treats all outlets the same. Cannot train others. Ignores competitive activity. 'Worked harder' is their only strategy for tough targets.",
      avoid:
        "Regional strategy. Org design. Advanced analytics. P&L management.",
    },
    {
      level: "Senior / Area Manager",
      test: "Regional strategy — where to expand, where to defend, where to retreat. Team building and performance management. Market expansion — opening new territory. P&L awareness. Stakeholder management (HQ, partners, local government).",
      askLike:
        `"You're given a new city to launch in. Walk me through your first 90 days." / "One of your field execs consistently misses target but is liked by retailers. How do you handle it?" / "Walk me through your approach to deciding which territories to expand vs consolidate." / "How do you balance HQ's growth targets with ground reality when they conflict?"`,
      good: "Thinks about territory as a portfolio with different needs. Can manage both high and low performers. Makes expansion decisions based on market analysis, not just 'more is better'. Navigates HQ vs ground-truth conflict productively.",
      bad: "Treats every territory the same. Cannot have difficult performance conversations. Expands everywhere without analysis. Either blindly follows HQ or ignores them entirely.",
      avoid:
        "National strategy. Board-level reporting. Technology decisions. Basic field execution.",
    },
    {
      level: "Director / Head of Field Operations",
      test: "National field operations strategy. Org design — tiers, spans, incentive structures. Unit economics of field operations. Vendor and partner strategy at scale. Building systems that scale the field without adding headcount linearly.",
      askLike:
        `"How do you design an incentive structure that drives the right behaviour across 500 field executives?" / "Walk me through scaling field operations from 3 cities to 30 — what breaks first?" / "How do you decide between your own field team vs a partner/vendor model?" / "Field costs are 35% of revenue. The board wants 25%. Walk me through your approach."`,
      good: "Thinks about field operations as a system — incentives, tools, route planning, hiring funnel, attrition. Can scale without linear headcount growth. Makes vendor-vs-own-team decisions strategically. Understands unit economics.",
      bad: "Only solution is 'hire more people'. Cannot design incentive structures. Thinks scaling means doing the same thing in more places. No unit economics awareness.",
      avoid:
        "Individual outlet management. Daily route planning. Basic sales skills.",
    },
  ],
};

const ENGINEERING_LEADERSHIP: DisciplineTaxonomy = {
  discipline: "engineering_leadership",
  preamble:
    "Engineering leadership screens test whether someone can deliver through others. The signal is not 'are they still a good engineer' but 'can they build a team that ships, grow the people on it, and make good technical bets without being the one writing the code'. People judgment, delivery systems, and technical credibility in equal measure.",
  levels: [
    {
      level: "Engineering Manager",
      test: "People management — hiring, growing, and when necessary managing out. Delivery systems — how their team ships reliably. Technical credibility — enough to evaluate work without micromanaging. Conflict resolution between team members and between teams. Handling failure — what they do when a project misses.",
      askLike:
        `"Tell me about a time you had to manage someone out. How did you handle it and how did the team respond?" / "Two senior engineers disagree on the architecture. Both have good arguments. What do you do?" / "How do you stay technical enough to evaluate your team's work without micromanaging?" / "Your team is behind on a commitment to another team. When do you escalate vs manage it yourself?" / "Your best engineer tells you they're considering leaving. Walk me through that conversation."`,
      good: "Has managed people through hard conversations, not just hired strong ones. Has a delivery system, not just 'we do standups'. Can evaluate technical work without needing to write it. Handles conflict directly rather than hoping it resolves itself. Owns team failures publicly.",
      bad: "Has never managed anyone out ('I've been lucky with hiring'). Delivery process is 'agile' with no specifics. Either too technical (micromanages) or not technical enough (can't evaluate). Avoids conflict. Blames the team when things go wrong.",
      avoid:
        "Coding questions. System design at the IC level. Algorithm puzzles. Asking them to 'write a design doc for X'.",
    },
    {
      level: "Senior Engineering Manager",
      test: "Managing managers — developing EMs, not just engineers. Multi-team coordination and dependencies. Headcount planning and budget. Hiring system design — not just interviewing, but the whole funnel. Organisational health metrics.",
      askLike:
        `"How do you develop a first-time engineering manager? What do you watch for in their first quarter?" / "Three of your teams have a shared dependency and keep stepping on each other. How do you solve this structurally?" / "Walk me through your approach to headcount planning — how do you justify a new team to the CTO?" / "How do you know when your org is healthy vs when something is quietly breaking?"`,
      good: "Develops managers, not just engineers. Can solve coordination problems structurally (not just 'more communication'). Makes headcount cases based on business impact. Reads organisational health signals before they become crises.",
      bad: "Manages engineers directly rather than through managers. Only solution to coordination is meetings. Cannot justify headcount beyond 'we need more people'. Surprised by attrition and morale problems.",
      avoid:
        "Individual contributor questions. Single-team problems. Basic management skills.",
    },
    {
      level: "Director / VP / Head of Engineering",
      test: "Org design — team structures, reporting lines, spans of control. Technical strategy at the org level — build-vs-buy, platform bets, migration decisions. Budget ownership. Executive communication. Cultural leadership — setting the engineering culture for the whole org. Recruiting strategy, not just recruiting.",
      askLike:
        `"You're merging two engineering orgs with different tech stacks, tools, and cultures. Walk me through your first 90 days." / "How do you decide your engineering investment portfolio — what percentage goes to new features vs platform vs tech debt?" / "Walk me through presenting an engineering strategy to the board — what do they need to understand?" / "How do you know it's time to split a team? What about merging two teams?"`,
      good: "Designs orgs for the business, not for the technology. Makes investment portfolio decisions (features vs platform vs debt). Communicates engineering to non-engineers at the executive level. Sets engineering culture deliberately. Has a recruiting strategy, not just a process.",
      bad: "Still thinks like an EM — solves team problems, not org problems. Cannot make portfolio allocation decisions. Communicates only to engineers. Culture is whatever happened, not something designed.",
      avoid:
        "Team-level management. Technical implementation details. Individual hiring decisions.",
    },
  ],
};

const ALL_TAXONOMIES: DisciplineTaxonomy[] = [
  BACKEND,
  FRONTEND,
  MOBILE,
  DEVOPS,
  DATA,
  PRODUCT,
  DESIGN,
  MARKETING,
  SUPPORT,
  FIELD,
  ENGINEERING_LEADERSHIP,
];

const taxonomyByDiscipline = new Map(ALL_TAXONOMIES.map((t) => [t.discipline, t]));

function renderLevelBlock(level: LevelBlock): string {
  return `Level: ${level.level}
  Test: ${level.test}
  Ask like: ${level.askLike}
  Good signal: ${level.good}
  Bad signal: ${level.bad}
  AVOID: ${level.avoid}`;
}

/**
 * Returns a prompt-ready text block with question design guidance for a
 * discipline. Includes ALL levels so the LLM can see the spectrum and pick
 * the right one based on the JD's seniority.
 *
 * Returns empty string for disciplines with no taxonomy (falls back to the
 * generic instructions already in the prompt).
 */
export function getTaxonomyGuidance(discipline: string): string {
  const tax = taxonomyByDiscipline.get(discipline);
  if (!tax) return "";

  const levelBlocks = tax.levels.map(renderLevelBlock).join("\n\n");

  return `
QUESTION DESIGN BY SENIORITY — ${tax.discipline.toUpperCase()} roles

${tax.preamble}

Read the seniority from the JD and MATCH your questions to the right level below. Seeing all levels helps you calibrate — what is appropriate for a junior is insulting for a senior, and what is appropriate for a director is meaningless for a junior.

${levelBlocks}

Use this as your question design brief. The "Ask like" examples are PATTERNS, not literal questions — generate actual questions from the JD and resume, shaped like these. The "AVOID" lines are hard constraints: do NOT generate questions of those types for that level.`;
}

/** All supported disciplines that have a taxonomy. */
export function taxonomyDisciplines(): string[] {
  return ALL_TAXONOMIES.map((t) => t.discipline);
}
