const fs = require("node:fs"),
  path = require("node:path"),
  { randomUUID } = require("node:crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const { buildBlueprint } = require("./build-blueprint.cjs");
const repo = path.resolve(__dirname, "../../.."),
  folder = path.join(repo, "work/po-dryrun");
if (!process.argv.includes("--live")) {
  console.error(
    "Requires --live: creates and deploys isolated timer-based dry-run artifacts on the configured tenant. No IDoc/SFTP/network receiver is included.",
  );
  process.exitCode = 1;
  return;
}
const cases = [
  { id: "valid", status: "COMPLETED" },
  { id: "zero-quantity", status: "FAILED", error: "PO_NUMBER_RANGE" },
  {
    id: "unknown-vendor",
    status: "FAILED",
    error: "MASTER_VENDOR_NOT_ALLOWED",
  },
];
(async () => {
  fs.mkdirSync(folder, { recursive: true });
  for (const tc of cases)
    if (!fs.existsSync(path.join(folder, "cases", tc.id + ".xlsx")))
      throw Error("Run npm run test:po-dryrun first");
  const client = new Client({ name: "excel-po-dryrun-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "dist/index.js")],
    cwd: repo,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const resume=process.argv.includes('--resume');
  const report = resume ? JSON.parse(fs.readFileSync(path.join(folder,'live-report.json'),'utf8')) : {
    mode: "dry-run",
    backendPoCreated: false,
    backendSchemaVerified: false,
    externalReceivers: 0,
    editorVerified: false,
    cases: [],
  };
  if (resume && (report.cases.length!==cases.length || report.cases.some((row,i)=>row.case!==cases[i].id || !/^McpExcelPoDryRun_[A-Za-z0-9_]+$/.test(row.id) || !row.taskId)))
    throw Error('Resume requires the saved dry-run report with all three existing artifacts/task IDs');
  const save = () =>
    fs.writeFileSync(
      path.join(folder, "live-report.json"),
      JSON.stringify(report, null, 2),
    );
  const parse = (r) => {
    const data = JSON.parse(r.content.find((c) => c.type === "text").text);
    if (r.isError) throw Error("MCP tool error: " + JSON.stringify(data));
    return data;
  };
  const call = async (name, args) => {
    if(!name.startsWith('get-'))console.log(JSON.stringify({ tool: name, stage: "calling" }));
    return parse(
      await client.callTool({ name, arguments: args }, undefined, {
        timeout: 180000,
      }),
    );
  };
  try {
    report.phase = "initializing";
    save();
    await client.connect(transport, { timeout: 180000 });
    report.mcpToolCount = (
      await client.listTools({}, { timeout: 180000 })
    ).tools.length;
    save();
    // Submit each deployment once. Polling below never resubmits a business message.
    for (const tc of resume ? [] : cases) {
      const id =
        "McpExcelPoDryRun_" +
        tc.id.replace(/-/g, "_") +
        "_" +
        randomUUID().replace(/-/g, "").slice(0, 8);
      const bp = buildBlueprint({
        id,
        caseName: tc.id,
        bytes: fs.readFileSync(path.join(folder, "cases", tc.id + ".xlsx")),
      });
      const row = {
        case: tc.id,
        id,
        coreNodes: bp.nodes.length,
        outcome: "unverified",
      };
      report.cases.push(row);
      report.phase = "preview";
      save();
      const preview = await call("preview-iflow-blueprint", { blueprint: bp });
      row.localValid = preview.validation.valid;
      report.phase = "create";
      save();
      const created = await call("create-iflow-from-blueprint", {
        packageId: "McpIflowSafetyLab20261019",
        blueprint: bp,
      });
      row.sapValidation = created.sap.status;
      report.phase = "deploy";
      save();
      const deployment = await call("start-iflow-deployment", { id });
      row.taskId = deployment.taskId;
      save();
      console.log(JSON.stringify({ case: tc.id, id, stage: "submitted" }));
    }
    for (let i = 0; i < cases.length; i++) {
      const tc = cases[i],
        row = report.cases[i],
        deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const deployment = await call("get-deployment-status", {
          taskId: row.taskId,
        });
        row.deployment = deployment.status;
        if (deployment.status === "FAILED") {
          row.outcome = "failed";
          break;
        }
        if (deployment.status !== "SUCCESS") {
          save();
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        const runtime = await call("get-iflow-runtime-status", { id: row.id });
        row.runtime = runtime.status;
        const rawDeploymentTime=runtime.runtime?.DeployedOn;
        const deploymentTime=rawDeploymentTime ? Date.parse(/Z$|[+-][0-9]{2}:[0-9]{2}$/.test(rawDeploymentTime)?rawDeploymentTime:rawDeploymentTime+'Z') : NaN;
        if (runtime.status === "STARTED") {
          const logs = await call("get-messages", {
            filterProps: { integrationFlowId: row.id },
          });
          const matched = (logs.messages || [])
            .map((log) => ({
              log,
              headers: Object.fromEntries(
                (log.customHeaderProperties || []).map((p) => [
                  p.Name,
                  p.Value,
                ]),
              ),
            }))
            .filter(({ log,headers }) => headers.DryRunCase === tc.id && (!Number.isFinite(deploymentTime) || Date.parse(log.logStart)>=deploymentTime));
          if (matched.length > 1)
            throw Error("Ambiguous MPL correlation for " + tc.id);
          if (matched.length === 1) {
            const { log, headers } = matched[0];
            row.mplStatus = log.status;
            row.messageGuid=log.messageGuid;
            row.logStart=log.logStart;
            row.evidence = headers;
            if (!["PROCESSING", "RETRY"].includes(log.status)) {
              const expectedResult = tc.error
                ? "REJECTED_OR_FAILED"
                : "CANDIDATE_VALIDATED_NOT_POSTED";
              row.outcome =
                log.status === tc.status &&
                headers.DryRunResult === expectedResult &&
                headers.DryRunExternalCalls === "0" &&
                (tc.error
                  ? headers.DryRunErrorCode === tc.error
                  : headers.DryRunOrderCount === "2" &&
                    headers.DryRunItemCount === "3" &&
                    headers.DryRunSchemaVerified === "false")
                  ? "passed"
                  : "failed";
              break;
            }
          }
        }
        save();
        await new Promise((r) => setTimeout(r, 3000));
      }
      save();
      console.log(
        JSON.stringify({
          case: tc.id,
          outcome: row.outcome,
          deployment: row.deployment,
          runtime: row.runtime,
          mpl: row.mplStatus,
          evidence: row.evidence,
        }),
      );
    }
    report.passed = report.cases.every((c) => c.outcome === "passed");
    report.phase = "finished";
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
  console.error(e.message);
  process.exitCode = 1;
});
