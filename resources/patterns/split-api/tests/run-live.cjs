// Explicit opt-in: creates isolated synthetic test artifacts. Never deploys a business receiver.
const fs = require("node:fs"),
  path = require("node:path"),
  { randomUUID } = require("node:crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const { sapTable } = require("../../../../dist/api/iflow/planner");
if (!process.argv.includes("--live"))
  throw Error("Requires --live for isolated CPI tests");
const repo = path.resolve(__dirname, "../../../.."),
  work = path.join(repo, "work/smart-patterns");
const sample =
  '<Batch><PurchaseOrder id="PO-A"><Item>1</Item><Item>2</Item></PurchaseOrder><PurchaseOrder id="PO-B"><Item>3</Item></PurchaseOrder></Batch>';
(async () => {
  fs.mkdirSync(work, { recursive: true });
  const client = new Client({
    name: "smart-component-verification",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "dist/index.js")],
    cwd: repo,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const resume = process.argv.includes("--resume");
  const report = resume
    ? JSON.parse(fs.readFileSync(path.join(work, "live-report.json"), "utf8"))
    : {
        mode: "synthetic-native-component-test",
        externalReceiversDeployed: 0,
        editorVerified: false,
        apiAdapterIoVerified: false,
        backendVerified: false,
        cases: [],
        httpDesigns: [],
      };
  if (
    resume &&
    (report.cases.length !== 3 ||
      !/^[A-Za-z0-9]+$/.test(report.packageId) ||
      report.cases.some(
        (r) => !/^McpSmart_[A-Za-z0-9_]+$/.test(r.id) || !r.taskId,
      ))
  )
    throw Error("Resume requires a complete saved isolated deployment report");
  delete report.error;
  const save = () =>
    fs.writeFileSync(
      path.join(work, "live-report.json"),
      JSON.stringify(report, null, 2),
    );
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 180000,
    });
    const value = JSON.parse(r.content.find((c) => c.type === "text").text);
    if (r.isError)
      throw Error("MCP " + name + " failed: " + JSON.stringify(value));
    return value;
  };
  const spec = (id, parallel = false) => ({
    id,
    goal: "split-api",
    inputFormat: "xml",
    endpoint: "/smart/" + id,
    receiver: {
      url: "https://mock.invalid/orders",
      method: "POST",
      authentication: { type: "none" },
      timeoutMs: 3000,
    },
    split: {
      xpath: "/Batch/PurchaseOrder",
      businessUnit: "purchaseOrder",
      recordElement: "PurchaseOrder",
      keyXPath: "@id",
      sampleXml: sample,
      parallel,
      concurrency: parallel ? 2 : 1,
      receiverEnforcesIdempotency: parallel,
      response: {
        format: "json",
        requiredFields: ["documentId"],
        expectedFields: { status: "accepted" },
      },
    },
  });
  try {
    await client.connect(transport, { timeout: 180000 });
    report.toolCount = (
      await client.listTools({}, { timeout: 180000 })
    ).tools.length;
    report.catalogCount = Object.keys(
      (await call("get-iflow-component-catalog", {})).components,
    ).length;
    const packageId = resume
      ? report.packageId
      : "McpSmartLab20261022" + randomUUID().replace(/-/g, "").slice(0, 6);
    report.packageId = packageId;
    if (!resume)
      await call("create-package", {
        id: packageId,
        name: packageId,
        shortText:
          "Synthetic planner, Splitter, local worker and Gather verification. No business API calls.",
      });
    save();
    for (const tc of resume
      ? []
      : [
          { id: "sequential", parallel: false },
          { id: "parallel", parallel: true },
          { id: "bad-response", error: "SMART_BUSINESS_RESPONSE" },
        ]) {
      const id =
        "McpSmart_" +
        tc.id.replace(/-/g, "_") +
        "_" +
        randomUUID().replace(/-/g, "").slice(0, 6);
      const planned = await call("plan-iflow", {
        plan: spec(id, !!tc.parallel),
      });
      if (!planned.readyForPreview) throw Error("Plan not ready");
      const bp = planned.blueprint;
      bp.sender = { type: "timer", runOnce: true };
      delete bp.endpoint;
      bp.nodes.splice(1, 0, {
        id: "CallActivity_LiveFixture",
        name: "Synthetic batch fixture",
        type: "contentModifier",
        properties: {
          bodyType: "constant",
          wrapContent: sample,
          propertyTable: sapTable([{ name: "SmartCase", value: tc.id }]),
        },
      });
      bp.edges = bp.nodes
        .slice(1)
        .map((n, i) => ({
          id: "LiveFlow_" + i,
          source: bp.nodes[i].id,
          target: n.id,
        }));
      const worker = bp.localProcesses[0],
        index = worker.nodes.findIndex((n) => n.type === "requestReply");
      // Replace only the transport with a native modifier. Real split/unwrap/guards/gather execute on CPI.
      worker.nodes[index] = {
        id: worker.nodes[index].id,
        name: "Synthetic API response - no network call",
        type: "contentModifier",
        properties: {
          bodyType: "expression",
          wrapContent:
            '{"documentId":"${header.X-Smart-Key}","status":"' +
            (tc.error ? "rejected" : "accepted") +
            '"}',
          headerTable: sapTable([
            { name: "CamelHttpResponseCode", value: "200" },
          ]),
        },
      };
      const analysis = await call("analyze-iflow-blueprint", {
        blueprint: bp,
        context: { inputFormat: "xml", sampleXml: sample },
      });
      const preview = await call("preview-iflow-blueprint", { blueprint: bp });
      const created = await call("create-iflow-from-blueprint", {
        packageId,
        blueprint: bp,
      });
      const deployment = await call("start-iflow-deployment", { id });
      const row = {
        case: tc.id,
        id,
        expectedError: tc.error,
        localValid: preview.validation.valid,
        analysisValid: analysis.valid,
        sapValidation: created.sap.status,
        taskId: deployment.taskId,
        outcome: "unverified",
      };
      report.cases.push(row);
      save();
      console.log(JSON.stringify({ case: tc.id, stage: "submitted" }));
    }
    // Validate each new HTTP configuration on SAP without deploying its external receiver.
    for (const auth of [
      { type: "none" },
      { type: "basic", credentialName: "SyntheticBasicAlias" },
      {
        type: "oauth2ClientCredentials",
        credentialName: "SyntheticOAuthAlias",
      },
    ]) {
      if (
        report.httpDesigns.some(
          (row) =>
            row.authentication === auth.type && row.sapValidation === "passed",
        )
      )
        continue;
      const id =
          "McpSmartHttp_" +
          auth.type +
          "_" +
          randomUUID().replace(/-/g, "").slice(0, 6),
        request = spec(id);
      request.receiver.authentication = auth;
      request.receiver.method =
        auth.type === "oauth2ClientCredentials" ? "PATCH" : "POST";
      const plan = await call("plan-iflow", { plan: request }),
        created = await call("create-iflow-from-blueprint", {
          packageId,
          blueprint: plan.blueprint,
        });
      report.httpDesigns.push({
        id,
        authentication: auth.type,
        method: request.receiver.method,
        sapValidation: created.sap.status,
        deployed: false,
        adapterIoVerified: false,
      });
      save();
    }
    for (const row of report.cases) {
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const deploy = await call("get-deployment-status", {
          taskId: row.taskId,
        });
        row.deployment = deploy.status;
        if (
          ["FAILED", "FAIL", "FAIL_ON_LICENSE_ERROR"].includes(deploy.status)
        ) {
          row.outcome = "failed";
          break;
        }
        if (deploy.status === "SUCCESS") {
          const runtime = await call("get-iflow-runtime-status", {
            id: row.id,
          });
          row.runtime = runtime.status;
          if (runtime.status === "STARTED") {
            const logs = await call("get-messages", {
              filterProps: { integrationFlowId: row.id },
            });
            const matching = (logs.messages || [])
              .map((log) => ({
                log,
                headers: Object.fromEntries(
                  (log.customHeaderProperties || []).map((p) => [
                    p.Name,
                    p.Value,
                  ]),
                ),
              }))
              .filter((v) => v.headers.SmartCase === row.case);
            if (matching.length > 1)
              throw Error("Ambiguous synthetic MPL correlation");
            if (
              matching.length === 1 &&
              !["PROCESSING", "RETRY"].includes(matching[0].log.status)
            ) {
              const { log, headers } = matching[0];
              row.mplStatus = log.status;
              row.messageGuid = log.messageGuid;
              row.logStart = log.logStart;
              row.evidence = headers;
              row.outcome = (
                row.expectedError
                  ? log.status === "FAILED" &&
                    headers.SmartErrorCode === row.expectedError
                  : log.status === "COMPLETED" &&
                    headers.SmartResult === "COMPLETE" &&
                    headers.SmartRecordCount === "2"
              )
                ? "passed"
                : "failed";
              break;
            }
          }
        }
        save();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      save();
      console.log(
        JSON.stringify({
          case: row.case,
          outcome: row.outcome,
          runtime: row.runtime,
          mpl: row.mplStatus,
        }),
      );
    }
    report.passed =
      report.cases.every((c) => c.outcome === "passed") &&
      report.httpDesigns.every((c) => c.sapValidation === "passed");
    save();
    if (!report.passed) process.exitCode = 2;
  } catch (e) {
    report.error = e.message;
    save();
    throw e;
  } finally {
    await client.close();
  }
})().catch((e) => {
  console.error(e.message.slice(0, 500));
  process.exitCode = 1;
});
