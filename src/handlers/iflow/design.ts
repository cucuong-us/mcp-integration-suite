import { z } from "zod";
import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { McpServerWithMiddleware } from "../../utils/middleware";
import { blueprintSchema, compileBlueprint } from "../../api/iflow/blueprint";
import {
  artifactPath,
  inspectDesign,
  validateOnSAP,
  withArtifactLock,
} from "../../api/iflow/safeDesign";
import { getCurrentDestination } from "../../api/api_destination";
import { formatError } from "../../utils/customErrHandler";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { deployIflow } from "../../api/iflow";
import { testIflow, testCaseSchema } from "../../api/iflow/testIflow";
import {
  getComponentCatalog,
  analyzeBlueprint,
  analysisContextSchema,
} from "../../api/iflow/componentIntelligence";
import { planSchema, planIflow } from "../../api/iflow/planner";
const result = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  isError,
});
export function registerDesignHandlers(server: McpServerWithMiddleware) {
  server.registerToolIntegrationSuite(
    "get-iflow-component-catalog",
    "Read decision guidance for every supported component/adapter: when to use it, required inputs, pitfalls, and unsupported SAP palette features. Start here before designing an unfamiliar scenario. Local only.",
    {},
    async () => result(getComponentCatalog()),
  );
  server.registerToolIntegrationSuite(
    "plan-iflow",
    "Plan a concrete blueprint from an explicit goal: transform, validate, route, split-api, parallel-enrichment, ordered-fanout, deliver, or reuse. Returns needs-input instead of guessing missing requirements. split-api requires normalized XML, sample record boundaries, unique business keys, HTTP auth/timeout and business response assertions; generates native Splitter/Local Process/Request Reply/Gather with completeness guards. No automatic retry or exactly-once guarantee. Local only; preview and SAP validation still required.",
    { plan: planSchema },
    async ({ plan }) => {
      try {
        return result(planIflow(plan));
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "analyze-iflow-blueprint",
    "Analyze component choice, XML/JSON compatibility, split business boundaries on a supplied sample, Gather pairing, swallowed errors, API error routes, write replay and partial side effects. Covers all currently supported node types; cannot certify backend semantics. Local only. Call before preview/create.",
    { blueprint: blueprintSchema, context: analysisContextSchema.optional() },
    async ({ blueprint, context }) => {
      try {
        const report = analyzeBlueprint(blueprint, context);
        return result(report, !report.valid);
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "test-iflow",
    "Send one synthetic POST to the canonical SAP runtime endpoint, assert status/body/JSON, and poll a uniquely correlated MPL. Does not retry payloads. PASS requires both assertions and expected MPL status; unmatched logs return unverified. Uses runtime CPI_OAUTH_* credentials.",
    { testCase: testCaseSchema },
    async ({ testCase }) => {
      try {
        const report = await testIflow(testCase);
        return result(report, report.outcome !== "passed");
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "preview-iflow-blueprint",
    "Compile a graph into an SAP iFlow ZIP with diagram and component analysis. Use get-iflow-component-catalog and plan-iflow first. Supports all catalogued types including xsltMapping/xmlValidator, typed splitter/gather, HTTP auth aliases/timeout/header allowlists, local processes, routing and multicast. Semantic errors block compilation; warnings require review. Bundle scripts/mappings/XSD/EDMX explicitly. Local only; does not certify editor, runtime or backend behavior.",
    { blueprint: blueprintSchema },
    async ({ blueprint }) => {
      try {
        const compiled = compileBlueprint(blueprint);
        const folder = path.resolve(__dirname, "../../../artifacts");
        await mkdir(folder, { recursive: true });
        const file = path.join(folder, randomUUID() + ".zip");
        await writeFile(file, compiled.buffer);
        return result({
          artifact: file,
          validation: compiled.validation,
          nodes: compiled.nodes,
          idMap: compiled.idMap,
          analysis: compiled.analysis,
        });
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "create-iflow-from-blueprint",
    "Create a NEW iFlow from a structured graph. Refuses existing IDs. Generates full diagram, checks archive, then calls SAP semantic validation. Does not deploy. Use validate-iflow-design and get-iflow-runtime-status separately; editor compatibility requires opening SAP editor.",
    { packageId: z.string().min(1), blueprint: blueprintSchema },
    async ({ packageId, blueprint }) => {
      try {
        return await withArtifactLock(
          "IntegrationDesigntimeArtifacts:" + blueprint.id,
          async () => {
            const compiled = compileBlueprint(blueprint);
            const dest = await getCurrentDestination();
            const exists = await executeHttpRequest(dest, {
              method: "GET",
              url: artifactPath(blueprint.id),
              validateStatus: () => true,
            });
            if (exists.status !== 404)
              throw new Error(
                exists.status === 200
                  ? "Artifact ID already exists; use update-iflow"
                  : "Cannot safely establish whether artifact exists: HTTP " +
                      exists.status,
              );
            const res = await executeHttpRequest(dest, {
              method: "POST",
              url: "IntegrationDesigntimeArtifacts",
              headers: { "Content-Type": "application/json" },
              data: {
                Id: blueprint.id,
                Name: blueprint.name,
                PackageId: packageId,
                ArtifactContent: compiled.buffer.toString("base64"),
              },
            });
            const sap = await validateOnSAP(blueprint.id);
            return result(
              {
                created: true,
                id: blueprint.id,
                httpStatus: res.status,
                local: compiled.validation,
                analysis: compiled.analysis,
                sap,
                editorVerified: false,
                readyForDeployment: sap.status === "passed",
              },
              sap.status !== "passed",
            );
          },
        );
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "validate-iflow-design",
    "Download and inspect ZIP/XML/diagram references/resources, and call SAP ValidateIntegrationDesigntimeArtifact. Does not deploy or edit. editorVerified remains false until an actual SAP editor check.",
    { id: z.string().min(1) },
    async ({ id }) => {
      try {
        const report = await inspectDesign(id);
        return result(report, !report.readyForDeployment);
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "get-iflow-runtime-status",
    "Read IntegrationRuntimeArtifacts.Status. STARTED confirms runtime readiness; absence of ErrorInformation alone does not. This is separate from design-time validation.",
    { id: z.string().min(1) },
    async ({ id }) => {
      try {
        const res = await executeHttpRequest(await getCurrentDestination(), {
          method: "GET",
          url: `IntegrationRuntimeArtifacts('${encodeURIComponent(id.replace(/'/g, "''"))}')`,
          headers: { Accept: "application/json" },
        });
        const runtime = res.data.d;
        return result({
          id,
          status: runtime.Status,
          ready: runtime.Status === "STARTED",
          runtime,
        });
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "start-iflow-deployment",
    "Validate local design and SAP semantics, then trigger deployment once. Returns task ID immediately. Poll get-deployment-status; do not trigger a new deploy merely because a wait timed out.",
    { id: z.string().min(1) },
    async ({ id }) => {
      try {
        return result({
          id,
          taskId: await deployIflow(id),
          status: "submitted",
        });
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
  server.registerToolIntegrationSuite(
    "get-deployment-status",
    "Read an existing deployment task without restarting it. SUCCESS is build/deploy success; also check get-iflow-runtime-status for STARTED.",
    { taskId: z.string().min(1) },
    async ({ taskId }) => {
      try {
        const res = await executeHttpRequest(await getCurrentDestination(), {
          method: "GET",
          url: `BuildAndDeployStatus(TaskId='${encodeURIComponent(taskId.replace(/'/g, "''"))}')`,
          headers: { Accept: "application/json" },
        });
        const d = res.data.d;
        return result(
          { taskId, status: d.Status, terminal: d.Status !== "DEPLOYING" },
          ["FAIL", "FAIL_ON_LICENSE_ERROR"].includes(d.Status),
        );
      } catch (e) {
        return { isError: true, content: [formatError(e)] };
      }
    },
  );
}
