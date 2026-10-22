// This runner uses actual generated Groovy/XSLT resources and a loopback HTTP mock.
// The Java harness models a documented subset of Splitter/Gather; it is not CPI.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { planIflow } = require("../../../../dist/api/iflow/planner");
const repo = path.resolve(__dirname, "../../../.."),
  work = path.join(repo, "work/smart-patterns");
const sample =
  '<Batch><PurchaseOrder id="PO-A"><Item>1</Item><Item>2</Item></PurchaseOrder><PurchaseOrder id="PO-B"><Item>3</Item></PurchaseOrder></Batch>';
const calls = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const key = req.headers["x-smart-key"];
    const url = new URL(req.url, "http://localhost");
    calls.push({
      case: url.searchParams.get("case"),
      key,
      body,
      correlation: req.headers["x-correlation-id"],
      method: req.method,
    });
    const send = (status, payload) => {
      if (!res.destroyed) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload);
      }
    };
    if (url.pathname === "/timeout")
      return setTimeout(() => send(200, "{}"), 300);
    if (/^\/status/.test(url.pathname))
      return send(Number(url.pathname.slice(7)), '{"error":"synthetic"}');
    if (url.pathname === "/partial" && key === "PO-B")
      return send(500, '{"error":"synthetic"}');
    if (url.pathname === "/bad-business")
      return send(200, JSON.stringify({ status: "rejected", documentId: key }));
    if (url.pathname === "/missing") return send(200, '{"status":"accepted"}');
    if (url.pathname === "/invalid-json") return send(200, "not-json");
    if (url.pathname === "/xml" || url.pathname === "/xml-rejected")
      return send(
        200,
        "<Ack><DocumentId>" +
          key +
          "</DocumentId><Status>" +
          (url.pathname === "/xml" ? "accepted" : "rejected") +
          "</Status></Ack>",
      );
    if (url.pathname === "/text") return send(200, "ACK " + key);
    if (url.pathname === "/text-rejected") return send(200, "REJECTED");
    if (url.pathname === "/invalid-xml") return send(200, "<Ack>");
    if (url.pathname === "/missing-xml") return send(200, "<Ack/>");
    send(201, JSON.stringify({ status: "accepted", documentId: key }));
  });
});
(async () => {
  fs.mkdirSync(work, { recursive: true });
  const jar = path.join(repo, "work/po-dryrun/tools/groovy-all-2.4.21.jar");
  if (!fs.existsSync(jar))
    throw Error(
      "Run npm run test:po-dryrun once to install the pinned Groovy runtime",
    );
  if (
    crypto.createHash("sha256").update(fs.readFileSync(jar)).digest("hex") !==
    "de65260cf2070442e99882f2f3d72e7531725c1e6a257446cc0cea525c607bd0"
  )
    throw Error("Groovy checksum mismatch");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const matrix = [
    { id: "json-success", route: "/ok", count: 2 },
    {
      id: "http-401",
      route: "/status401",
      error: "SMART_HTTP_FAILURE",
      count: 1,
    },
    {
      id: "http-429",
      route: "/status429",
      error: "SMART_HTTP_FAILURE",
      count: 1,
    },
    {
      id: "http-500",
      route: "/status500",
      error: "SMART_HTTP_FAILURE",
      count: 1,
    },
    {
      id: "timeout-no-replay",
      route: "/timeout",
      error: "SMART_HTTP_TIMEOUT",
      count: 1,
    },
    {
      id: "partial-side-effects",
      route: "/partial",
      error: "SMART_HTTP_FAILURE",
      count: 2,
    },
    {
      id: "business-rejection",
      route: "/bad-business",
      error: "SMART_BUSINESS_RESPONSE",
      count: 1,
    },
    {
      id: "missing-business-field",
      route: "/missing",
      error: "SMART_BUSINESS_RESPONSE",
      count: 1,
    },
    {
      id: "invalid-json",
      route: "/invalid-json",
      error: "SMART_RESPONSE_JSON",
      count: 1,
    },
    { id: "xml-success", route: "/xml", format: "xml", count: 2 },
    {
      id: "xml-business-rejected",
      route: "/xml-rejected",
      format: "xml",
      count: 1,
      error: "SMART_BUSINESS_RESPONSE",
    },
    { id: "text-success", route: "/text", format: "text", count: 2 },
    {
      id: "text-business-rejected",
      route: "/text-rejected",
      format: "text",
      count: 1,
      error: "SMART_BUSINESS_RESPONSE",
    },
    {
      id: "invalid-xml",
      route: "/invalid-xml",
      format: "xml",
      error: "SMART_RESPONSE_XML",
      count: 1,
    },
    {
      id: "missing-xml-field",
      route: "/missing-xml",
      format: "xml",
      error: "SMART_BUSINESS_RESPONSE",
      count: 1,
    },
    {
      id: "duplicate-input-key",
      route: "/ok",
      body: sample.replace("PO-B", "PO-A"),
      error: "SMART_RECORD_KEY",
      count: 0,
    },
    {
      id: "traversal-input-key",
      route: "/ok",
      body: sample.replace("PO-B", ".."),
      error: "SMART_RECORD_KEY",
      count: 0,
    },
    {
      id: "empty-batch",
      route: "/ok",
      body: "<Batch/>",
      error: "SMART_RECORD_COUNT",
      count: 0,
    },
    {
      id: "missing-gather-result",
      route: "/ok",
      mutation: "drop",
      error: "SMART_INCOMPLETE_BATCH",
      count: 2,
    },
    {
      id: "duplicate-gather-key",
      route: "/ok",
      mutation: "duplicate",
      error: "SMART_GATHER_RESULT",
      count: 2,
    },
    {
      id: "foreign-gather-key",
      route: "/ok",
      mutation: "foreign",
      error: "SMART_GATHER_KEYS",
      count: 2,
    },
  ];
  const cases = matrix.map((tc) => {
    let response =
      tc.format === "xml"
        ? {
            format: "xml",
            successCodes: [200],
            requiredXmlPaths: ["/Ack/DocumentId"],
            expectedXmlValues: { "/Ack/Status": "accepted" },
          }
        : {
            format: "json",
            successCodes: [201, 200],
            requiredFields: ["documentId"],
            expectedFields: { status: "accepted" },
          };
    if (tc.format === "text")
      response = { format: "text", successCodes: [200], bodyContains: "ACK " };
    const plan = planIflow({
      id: "Mock_" + tc.id.replace(/-/g, "_"),
      goal: "split-api",
      inputFormat: "xml",
      endpoint: "/mock",
      receiver: {
        url: "https://mock.invalid" + tc.route,
        method: "POST",
        timeoutMs: tc.route === "/timeout" ? 50 : 3000,
      },
      split: {
        xpath: "/Batch/PurchaseOrder",
        businessUnit: "purchaseOrder",
        recordElement: "PurchaseOrder",
        keyXPath: "@id",
        sampleXml: sample,
        response,
      },
    });
    if (!plan.readyForPreview) throw Error("Mock plan not ready");
    return {
      ...tc,
      body: tc.body || sample,
      mockUrl: `http://127.0.0.1:${port}${tc.route}?case=${tc.id}`,
      blueprint: plan.blueprint,
    };
  });
  fs.writeFileSync(path.join(work, "cases.json"), JSON.stringify(cases));
  await new Promise((resolve, reject) => {
    const child = spawn(
      "java",
      [
        "-cp",
        jar,
        "groovy.ui.GroovyMain",
        path.join(__dirname, "run.groovy"),
        repo,
        path.join(work, "cases.json"),
        path.join(work, "groovy-report.json"),
      ],
      { cwd: repo, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(Error("Groovy harness exit " + code)),
    );
  });
  const report = JSON.parse(
    fs.readFileSync(path.join(work, "groovy-report.json"), "utf8"),
  );
  for (const tc of cases) {
    const actual = calls.filter((c) => c.case === tc.id),
      row = report.cases.find((c) => c.id === tc.id);
    row.httpCalls = actual.length;
    row.expectedHttpCalls = tc.count;
    row.noReplay = actual.every(
      (c, i) => actual.findIndex((other) => other.key === c.key) === i,
    );
    row.completeRecords = actual.every(
      (c) =>
        /^<PurchaseOrder\b/.test(c.body) &&
        !c.body.includes("<Batch") &&
        (c.body.match(/<Item>/g) || []).length === (c.key === "PO-A" ? 2 : 1),
    );
    row.correlation = actual.every((c) =>
      /^[0-9a-f-]{36}$/.test(c.correlation),
    );
    row.passed =
      row.passed &&
      actual.length === tc.count &&
      row.noReplay &&
      row.completeRecords &&
      row.correlation;
  }
  report.passed = report.cases.every((c) => c.passed);
  report.mockScope =
    "Loopback HTTP with generated Groovy/XSLT; Splitter/Gather modeled by harness, not CPI";
  fs.writeFileSync(
    path.join(work, "mock-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      total: report.cases.length,
      report: "work/smart-patterns/mock-report.json",
    }),
  );
  if (!report.passed) process.exitCode = 1;
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => server.close());
