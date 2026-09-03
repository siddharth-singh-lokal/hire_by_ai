import { redact, scanForLeaks } from "./redact";

// Verbatim fragments from Lokal's Confluence BD space + planted credentials.
const sample = `
Summary — Agrilokal now reuses database connections. Ticket: AL-2089.
Login to server: 172.31.31.9 (named analytics_ec2_new on EC2)
Served via 172.31.30.98 (website_server-latest)
On https://analytics.getlokalapp.com/admin/queries/tasks you can see the worker.
DB hosts come from the agrilokal-secret in namespace prod.
Key commits: 52c8f1d3 (add pooling), 28169d1a (env toggle), 50a26b38 (min/max 2).
orig_table = client.get_table("lokal-98112.kafka_analytics_data_dump.web_submission_log")
scp -i key.pem index.php ubuntu@ec2-13-127-234-0.ap-south-1.compute.amazonaws.com:/var/www/html/
Redirects to http://telugu.getlokalapp.com or http://tamil.getlokalapp.com
Contact ops at krishnendu@getlokalapp.com or call 9876543210
AWS_SECRET_ACCESS_KEY=d1D2TVyIJDrHCrtGW2Uk9SevYOQ9nGFhO2rZEkyE
export OPENAI_KEY=sk-proj-dkqBhhpBP9eDCQ6Q1aIcpEiyAdSCbZaiEMcW
Repo: https://bitbucket.org/getlokalapp/share-website/src/master/
The pool is capped at 2 because the DB is a db.t4g.micro with 2 vCPUs.
MAX_IDLE must stay lower than the server idle_session_timeout.
`;

const { clean, findings } = redact(sample);
console.log("=== REDACTED OUTPUT ===");
console.log(clean.trim());
console.log("\n=== WHAT IT CAUGHT ===");
findings.forEach(f => console.log(`  ${f.rule.padEnd(22)} x${String(f.count).padEnd(3)} e.g. ${f.sample}`));
console.log("\n=== VALIDATION GATE ON OUTPUT ===");
const leaks = scanForLeaks(clean);
console.log(leaks.length === 0 ? "  PASS - no leaks detected" : "  FAIL:");
leaks.forEach(f => console.log(`    LEAK ${f.rule} x${f.count} e.g. ${f.sample}`));
