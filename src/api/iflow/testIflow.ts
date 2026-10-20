import { z } from "zod";
import { randomUUID } from "node:crypto";
import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { getCurrentDestination } from "../api_destination";
import { getEndpoints } from "./index";
import { sendRequestToCPI } from "../messages/sendMessageToCPI";
export const testCaseSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  contentType: z.string().default("application/json"),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  expectedBodyContains: z.string().optional(),
  expectedJson: z.record(z.unknown()).optional(),
  expectedMplStatus: z
    .enum(["COMPLETED", "FAILED", "ESCALATED"])
    .default("COMPLETED"),
  csrfProtected: z.boolean().default(true),
  waitSeconds: z.number().int().min(1).max(120).default(45),
});
export function containsJson(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object")
    return actual === expected;
  if (
    typeof actual !== "object" ||
    actual === null ||
    Array.isArray(expected) !== Array.isArray(actual)
  )
    return false;
  return Object.entries(expected).every(([k, v]) =>
    containsJson((actual as Record<string, unknown>)[k], v),
  );
}
/** Sends exactly once; a timeout never resubmits a business message. */
export async function testIflow(input: z.input<typeof testCaseSchema>) {
  const tc = testCaseSchema.parse(input),
    dest = await getCurrentDestination();
  const runtime = await executeHttpRequest(dest, {
    method: "GET",
    url: `IntegrationRuntimeArtifacts('${encodeURIComponent(tc.id.replace(/'/g, "''"))}')`,
    headers: { Accept: "application/json" },
  });
  if (runtime.data.d.Status !== "STARTED")
    return {
      outcome: "not-ready",
      runtimeStatus: runtime.data.d.Status,
      sent: false,
    };
  const endpoints = await getEndpoints(tc.id);
  const urls = endpoints
    .filter((e) => e.protocol === "REST")
    .flatMap((e) => e.entryPoints || [])
    .map((e) => e.url)
    .filter((u) => /^https:\/\//.test(u));
  if (urls.length !== 1)
    throw new Error("Expected one HTTPS REST entrypoint; found " + urls.length);
  const endpoint = new URL(urls[0]);
  const applicationId = "mcp-test-" + randomUUID();
  const response = await sendRequestToCPI(
    endpoint.pathname + endpoint.search,
    "POST",
    tc.contentType,
    tc.body,
    [{ key: "SAP_ApplicationID", value: applicationId }],
    tc.csrfProtected,
    endpoint.origin,
  );
  const assertions: { name: string; passed: boolean }[] = [
    { name: "httpStatus", passed: response.status === tc.expectedStatus },
  ];
  if (tc.expectedBodyContains !== undefined)
    assertions.push({
      name: "bodyContains",
      passed: response.response.includes(tc.expectedBodyContains),
    });
  if (tc.expectedJson !== undefined) {
    let actual;
    try {
      actual = JSON.parse(response.response);
    } catch {}
    assertions.push({
      name: "jsonSubset",
      passed: containsJson(actual, tc.expectedJson),
    });
  }
  if (response.status === 401 || response.status === 403)
    return {
      outcome: "failed",
      applicationId,
      response,
      assertions,
      mpl: { status: "unverified", reason: "Runtime authorization failed" },
    };
  const deadline = Date.now() + tc.waitSeconds * 1000;
  let mpl: any;
  do {
    const filter = response.messageGuid
      ? `MessageGuid eq '${response.messageGuid.replace(/'/g, "''")}'`
      : `ApplicationMessageId eq '${applicationId}'`;
    const logs = await executeHttpRequest(dest, {
      method: "GET",
      url: "MessageProcessingLogs",
      headers: { Accept: "application/json" },
      params: { $filter: filter, $top: 10 },
    });
    const matching = (logs.data.d?.results || []).filter(
      (r: any) => r.IntegrationArtifact?.Id === tc.id,
    );
    if (matching.length > 1)
      throw new Error(
        "Correlation matched multiple MPLs; refusing ambiguous test result",
      );
    mpl = matching[0];
    if (mpl && !["PROCESSING", "RETRY"].includes(mpl.Status)) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1500));
  } while (true);
  const mplVerified = !!mpl && mpl.Status === tc.expectedMplStatus;
  return {
    outcome:
      assertions.every((a) => a.passed) && mplVerified
        ? "passed"
        : !assertions.every((a) => a.passed) ||
            (!!mpl && !["PROCESSING", "RETRY"].includes(mpl.Status))
          ? "failed"
          : "unverified",
    applicationId,
    response,
    assertions,
    mpl: mpl
      ? {
          messageGuid: mpl.MessageGuid,
          status: mpl.Status,
          expected: tc.expectedMplStatus,
          verified: mplVerified,
        }
      : {
          status: "unverified",
          reason:
            "No uniquely correlated MPL found. SAP_ApplicationID must be accepted by the sender; a successful HTTP response alone is insufficient.",
        },
  };
}
