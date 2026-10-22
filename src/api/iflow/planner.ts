import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as xpath from "xpath";
import {
  blueprintSchema,
  nodeSchema,
  httpReceiver,
  Blueprint,
} from "./blueprintSchema";
import { analyzeBlueprint, selectSample } from "./componentIntelligence";

const format = z.enum(["xml", "json", "text", "unknown"]);
const simplePath = z
  .string()
  .regex(
    /^\/(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*(?:\/(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)+$/,
  );
export const planSchema = z
  .object({
    id: blueprintSchema.shape.id,
    name: blueprintSchema.shape.name.optional(),
    goal: z.enum([
      "transform",
      "validate",
      "route",
      "split-api",
      "parallel-enrichment",
      "ordered-fanout",
      "deliver",
      "reuse",
    ]),
    inputFormat: format.default("unknown"),
    outputFormat: format.optional(),
    sender: blueprintSchema.shape.sender.optional(),
    endpoint: blueprintSchema.shape.endpoint.optional(),
    namespaces: blueprintSchema.shape.namespaces.optional(),
    resources: blueprintSchema.shape.resources.optional(),
    steps: z.array(nodeSchema).max(20).optional(),
    receiver: nodeSchema.shape.receiver.optional(),
    branches: z
      .array(
        z
          .object({
            name: z.string().min(1),
            condition: z.string().optional(),
            expressionType: z.enum(["XML", "NonXML"]).default("NonXML"),
            default: z.boolean().default(false),
            steps: z.array(nodeSchema).min(1).max(10),
          })
          .strict(),
      )
      .min(2)
      .max(8)
      .optional(),
    split: z
      .object({
        xpath: simplePath,
        businessUnit: z.string().min(1).max(100),
        recordElement: z.string().regex(/^[A-Za-z_][\w.-]*$/),
        keyXPath: z
          .string()
          .regex(/^(?:@?[A-Za-z_][\w.-]*)(?:\/@?[A-Za-z_][\w.-]*)*$/),
        sampleXml: z.string().max(1024 * 1024),
        maxRecords: z.number().int().min(1).max(1000).default(100),
        parallel: z.boolean().default(false),
        concurrency: z.number().int().min(1).max(50).default(1),
        totalTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
        response: z
          .object({
            format: z.enum(["xml", "json", "text"]),
            successCodes: z
              .array(z.number().int().min(200).max(299))
              .min(1)
              .default([200, 201]),
            requiredFields: z
              .array(
                z.string().regex(/^[A-Za-z_][\w.-]*(?:\.[A-Za-z_][\w.-]*)*$/),
              )
              .default([]),
            expectedFields: z
              .record(z.union([z.string(), z.number(), z.boolean()]))
              .default({}),
            requiredXmlPaths: z
              .array(z.string().regex(/^\/[A-Za-z_][\w./:@-]*$/))
              .default([]),
            expectedXmlValues: z
              .record(z.string().regex(/^\/[A-Za-z_][\w./:@-]*$/), z.string())
              .default({}),
            bodyContains: z.string().min(1).max(1000).optional(),
          })
          .strict(),
        receiverEnforcesIdempotency: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PlanInput = z.input<typeof planSchema>;
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
export function sapTable(
  entries: { name: string; value: string; type?: string }[],
) {
  return entries
    .map(
      (e) =>
        "<row>" +
        Object.entries({
          Action: "Create",
          Type: e.type || "constant",
          Value: e.value,
          Default: "",
          Name: e.name,
          Datatype: "java.lang.String",
        })
          .map(([k, v]) => `<cell id='${k}'>${xml(v)}</cell>`)
          .join("") +
        "</row>",
    )
    .join("");
}
function chain(nodes: any[], prefix: string) {
  return nodes
    .slice(1)
    .map((n, i) => ({ id: prefix + i, source: nodes[i].id, target: n.id }));
}
export function planIflow(input: PlanInput) {
  const p = planSchema.parse(input),
    requiredInputs: string[] = [];
  if (p.receiver && !["deliver", "split-api"].includes(p.goal))
    throw new Error("receiver is not used by this planning goal");
  if (p.split && p.goal !== "split-api")
    throw new Error("split is only used by split-api");
  if (
    p.branches &&
    !["route", "parallel-enrichment", "ordered-fanout"].includes(p.goal)
  )
    throw new Error("branches are not used by this planning goal");
  const needs = (field: string) => requiredInputs.push(field);
  const bp: Blueprint = {
    id: p.id,
    name: p.name || p.id,
    sender: p.sender || { type: "https" },
    endpoint: p.endpoint,
    namespaces: p.namespaces,
    resources: p.resources || [],
    nodes: [],
    edges: [],
  };
  if ((bp.sender?.type || "https") === "https" && !bp.endpoint)
    needs("endpoint for HTTPS sender");
  const start = {
      id: "StartEvent_Planned",
      name: "Receive input",
      type: "start" as const,
    },
    end = { id: "EndEvent_Planned", name: "End", type: "end" as const };
  const choices: Record<string, string[]> = {
    transform: ["xmlToJson", "jsonToXml", "xsltMapping", "messageMapping"],
    validate: ["xmlValidator"],
    route: ["router"],
    "split-api": ["generalSplitter", "processCall", "requestReply", "gather"],
    "parallel-enrichment": ["multicast", "join", "gather"],
    "ordered-fanout": ["sequentialMulticast", "join", "gather"],
    deliver: ["send", "requestReply"],
    reuse: ["processCall"],
  };
  if (p.goal === "split-api") {
    if (!p.split)
      needs(
        "split: complete-record XPath, business unit, record element, unique keyXPath, representative sample and response contract",
      );
    if (!p.receiver || (p.receiver.type && p.receiver.type !== "http"))
      needs("HTTP receiver endpoint, method, authentication and timeout");
  } else if (p.goal === "transform") {
    let steps = p.steps;
    if (!steps?.length && p.inputFormat === "xml" && p.outputFormat === "json")
      steps = [
        {
          id: "CallActivity_Convert",
          name: "XML to JSON",
          type: "xmlToJson",
          properties: {},
        },
      ];
    if (!steps?.length && p.inputFormat === "json" && p.outputFormat === "xml")
      steps = [
        {
          id: "CallActivity_Convert",
          name: "JSON to XML",
          type: "jsonToXml",
          properties: {},
        },
      ];
    if (!steps?.length)
      needs(
        "steps with a specific mapping/conversion and its resources, or XML/JSON input/output formats",
      );
    else bp.nodes = [start, ...steps, end];
  } else if (p.goal === "validate") {
    if (!p.steps?.some((s) => s.type === "xmlValidator"))
      needs(
        "XML Validator step and a bundled XSD; business/master-data checks remain explicit",
      );
    else bp.nodes = [start, ...p.steps, end];
  } else if (p.goal === "deliver") {
    if (!p.receiver) needs("receiver adapter and destination");
    else
      bp.nodes = [
        start,
        ...(p.steps || []),
        {
          id: "ServiceTask_Deliver",
          name: "Deliver",
          type: ["jms", "sftp"].includes(p.receiver.type || "")
            ? "send"
            : "requestReply",
          receiver: p.receiver,
        },
        end,
      ];
  } else if (p.goal === "reuse") {
    if (!p.steps?.length) needs("steps to execute in the local process");
    else {
      const worker = [
        { id: "LocalStart", name: "Start", type: "start" as const },
        ...p.steps,
        { id: "LocalEnd", name: "End", type: "end" as const },
      ];
      bp.localProcesses = [
        {
          id: "ReusableWorker",
          name: "Reusable worker",
          nodes: worker,
          edges: chain(worker, "LocalFlow_"),
        },
      ];
      bp.nodes = [
        start,
        {
          id: "CallActivity_Worker",
          name: "Call reusable worker",
          type: "processCall",
          processId: "ReusableWorker",
        },
        end,
      ];
    }
  } else {
    if (!p.branches)
      needs(
        "named branches with concrete steps; Router also needs conditions and one default",
      );
    else {
      const routed = p.goal === "route";
      if (
        routed &&
        (p.branches.filter((b) => b.default).length !== 1 ||
          p.branches.some((b) => !b.default && !b.condition))
      )
        needs(
          "exactly one default branch and conditions for other Router branches",
        );
      if (!routed && !p.outputFormat)
        needs("outputFormat shared by all branch results");
      if (
        !routed &&
        p.outputFormat &&
        !["xml", "text"].includes(p.outputFormat)
      )
        needs(
          "an explicit mapping/envelope for JSON fan-out results; text concatenation is not JSON aggregation",
        );
      bp.nodes = [
        start,
        {
          id: routed ? "ExclusiveGateway_Choose" : "ParallelGateway_Fanout",
          name: p.goal,
          type: routed
            ? "router"
            : p.goal === "ordered-fanout"
              ? "sequentialMulticast"
              : "multicast",
          ...(!routed ? { joinId: "ParallelGateway_Join" } : {}),
        },
      ];
      bp.edges = [
        { id: "Flow_Start", source: start.id, target: bp.nodes[1].id },
      ];
      p.branches.forEach((branch, i) => {
        bp.nodes.push(...branch.steps);
        bp.edges.push(
          {
            id: "Branch_" + i,
            name: branch.name,
            source: bp.nodes[1].id,
            target: branch.steps[0].id,
            ...(routed
              ? {
                  default: branch.default,
                  condition: branch.condition,
                  expressionType: branch.expressionType,
                }
              : {}),
          },
          ...chain(branch.steps, "BranchFlow_" + i + "_"),
        );
        if (routed) {
          const e = {
            id: "EndEvent_Branch_" + i,
            name: "End " + branch.name,
            type: "end" as const,
          };
          bp.nodes.push(e);
          bp.edges.push({
            id: "BranchEnd_" + i,
            source: branch.steps.at(-1)!.id,
            target: e.id,
          });
        } else
          bp.edges.push({
            id: "BranchJoin_" + i,
            source: branch.steps.at(-1)!.id,
            target: "ParallelGateway_Join",
          });
      });
      if (!routed) {
        bp.nodes.push(
          { id: "ParallelGateway_Join", name: "Join branches", type: "join" },
          {
            id: "CallActivity_Gather",
            name: "Gather branch results",
            type: "gather",
            gather: { format: p.outputFormat === "xml" ? "xmlSame" : "text" },
          },
          end,
        );
        bp.edges.push(
          {
            id: "JoinGather",
            source: "ParallelGateway_Join",
            target: "CallActivity_Gather",
          },
          { id: "GatherEnd", source: "CallActivity_Gather", target: end.id },
        );
      }
    }
  }
  if (requiredInputs.length)
    return {
      status: "needs-input",
      readyForPreview: false,
      recommendedComponents: choices[p.goal],
      requiredInputs,
      blueprint: null,
    };
  if (p.goal === "split-api") buildSplitApi(bp, p);
  else if (!bp.edges.length) bp.edges = chain(bp.nodes, "Flow_");
  const analysis = analyzeBlueprint(bp, {
    inputFormat: p.inputFormat,
    sampleXml: p.split?.sampleXml,
  });
  return {
    status: analysis.valid ? "planned" : "needs-review",
    readyForPreview: analysis.valid,
    requiredInputs: [],
    recommendedComponents: choices[p.goal],
    blueprint: bp,
    analysis,
    guarantees: {
      runtimeVerified: false,
      backendVerified: false,
      automaticRetries: false,
      exactlyOnce: false,
    },
    next: [
      "preview-iflow-blueprint",
      "create-iflow-from-blueprint",
      "start-iflow-deployment",
      "get-iflow-runtime-status",
      "test-iflow and backend reconciliation",
    ],
  };
}
function buildSplitApi(bp: Blueprint, p: z.output<typeof planSchema>) {
  const s = p.split!,
    r = httpReceiver.parse(p.receiver);
  if (p.inputFormat !== "xml")
    throw new Error(
      "split-api requires normalized XML; convert Excel/JSON before this pattern",
    );
  if (
    s.parallel &&
    !["GET", "HEAD"].includes(r.method) &&
    !s.receiverEnforcesIdempotency
  )
    throw new Error(
      "Parallel writes require receiver-enforced idempotency; use sequential calls otherwise",
    );
  if (s.parallel && s.concurrency < 2)
    throw new Error("Parallel split needs concurrency >= 2");
  if (!s.parallel && s.concurrency !== 1)
    throw new Error("Sequential split requires concurrency=1");
  if (
    s.parallel &&
    s.totalTimeoutSeconds <=
      (Math.ceil(s.maxRecords / s.concurrency) * r.timeoutMs) / 1000
  )
    throw new Error(
      "Parallel splitter timeout budget must exceed worst-case receiver wait for maxRecords/concurrency; lower maxRecords or increase totalTimeoutSeconds",
    );
  if (r.errorHandling !== "throw")
    throw new Error(
      "split-api uses fail-fast HTTP errors; routed/partial errors require a separate reviewed pattern",
    );
  const records = selectSample(s.sampleXml, s.xpath, p.namespaces || {});
  if (!records.length || records.length > s.maxRecords)
    throw new Error("Sample record count outside configured bounds");
  if (records.some((n) => n.localName !== s.recordElement))
    throw new Error(
      "Sample does not select the declared business record element",
    );
  if (
    /\b(po|purchase.?order)\b/i.test(s.businessUnit) &&
    /^(item|line|row)$/i.test(s.recordElement)
  )
    throw new Error(
      "Purchase-order requests must split complete POs, not item rows",
    );
  const keys = records.map((record) =>
    String(
      xpath.useNamespaces(p.namespaces || {})(
        "string(" + s.keyXPath + ")",
        record as any,
      ),
    ).trim(),
  );
  if (
    keys.some(
      (k) =>
        !k || [".", ".."].includes(k) || !/^[A-Za-z0-9_.:-]{1,100}$/.test(k),
    ) ||
    new Set(keys).size !== keys.length
  )
    throw new Error(
      "Sample business keys must be nonempty, unique and safe header values",
    );
  if (
    s.response.format === "json" &&
    !s.response.requiredFields.length &&
    !Object.keys(s.response.expectedFields).length
  )
    throw new Error(
      "JSON response requires requiredFields or expectedFields business assertions",
    );
  if (
    s.response.format === "xml" &&
    !s.response.requiredXmlPaths.length &&
    !Object.keys(s.response.expectedXmlValues).length
  )
    throw new Error(
      "XML response requires requiredXmlPaths business assertions",
    );
  if (s.response.format === "text" && !s.response.bodyContains)
    throw new Error(
      "Text response requires an explicit bodyContains business assertion",
    );
  const { sampleXml, ...settings } = s;
  const config = { ...settings, namespaces: p.namespaces || {} };
  const templateRoot = path.resolve(
    __dirname,
    "../../../resources/patterns/split-api",
  );
  for (const script of [
    "GuardBatch",
    "GuardResponse",
    "AuditBatch",
    "RecordFailure",
  ])
    bp.resources!.push({
      path: "src/main/resources/script/Smart" + script + ".groovy",
      content: readFileSync(
        path.join(templateRoot, script + ".groovy"),
        "utf8",
      ).replace(
        "__CONFIG_BASE64__",
        Buffer.from(JSON.stringify(config)).toString("base64"),
      ),
    });
  const ns = Object.entries(p.namespaces || {})
    .map(([prefix, uri]) => `xmlns:${prefix}="${xml(uri)}"`)
    .join(" ");
  bp.resources!.push({
    path: "src/main/resources/mapping/SmartUnwrapRecord.xsl",
    content: `<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" ${ns}><xsl:output method="xml" omit-xml-declaration="yes"/><xsl:template match="/"><xsl:copy-of select="${xml(s.xpath)}"/></xsl:template></xsl:stylesheet>`,
  });
  const headers = [
    { name: "Content-Type", value: "application/xml" },
    {
      name: "X-Correlation-ID",
      value: "${property.SmartBatchId}",
      type: "expression",
    },
    { name: "X-Smart-Key", value: s.xpath + "/" + s.keyXPath, type: "xpath" },
  ];
  if (s.receiverEnforcesIdempotency)
    headers.push({
      name: "Idempotency-Key",
      value: s.xpath + "/" + s.keyXPath,
      type: "xpath",
    });
  const worker: any[] = [
    { id: "WorkerStart", name: "Start record", type: "start" },
    {
      id: "WorkerHeaders",
      name: "Set record key and correlation headers",
      type: "contentModifier",
      properties: {
        bodyType: "expression",
        wrapContent: "${in.body}",
        headerTable: sapTable(headers),
      },
    },
    {
      id: "WorkerUnwrap",
      name: "XSLT - remove General Splitter envelope",
      type: "xsltMapping",
      properties: {
        mappinguri:
          "dir://mapping/xslt/src/main/resources/mapping/SmartUnwrapRecord.xsl",
        mappingname: "SmartUnwrapRecord",
        mappingpath: "src/main/resources/mapping/SmartUnwrapRecord",
      },
    },
    {
      id: "WorkerCall",
      name: "Request Reply - one complete business record",
      type: "requestReply",
      receiver: {
        ...r,
        responseFormat: s.response.format,
        requestHeaders: [
          ...new Set([...r.requestHeaders, ...headers.map((h) => h.name)]),
        ],
      },
    },
    {
      id: "WorkerCheck",
      name: "Assert HTTP and business response contract",
      type: "groovy",
      properties: { script: "SmartGuardResponse.groovy" },
    },
    { id: "WorkerEnd", name: "Record result", type: "end" },
  ];
  bp.localProcesses = [
    {
      id: "RecordWorker",
      name: "One API operation per business record",
      nodes: worker,
      edges: chain(worker, "WorkerFlow_"),
      exceptionHandler: {
        script: "SmartRecordFailure.groovy",
        name: "Record worker failure",
        end: "error",
      },
    },
  ];
  bp.nodes = [
    { id: "StartEvent_Planned", name: "Receive XML batch", type: "start" },
    {
      id: "CallActivity_BatchGuard",
      name: "Validate record count and unique business keys",
      type: "groovy",
      properties: { script: "SmartGuardBatch.groovy" },
    },
    {
      id: "CallActivity_Split",
      name: "Split complete " + s.businessUnit,
      type: "generalSplitter",
      splitter: {
        xpath: s.xpath,
        businessUnit: s.businessUnit,
        recordElement: s.recordElement,
        grouping: 1,
        parallel: s.parallel,
        concurrency: s.concurrency,
        timeoutSeconds: s.totalTimeoutSeconds,
        stopOnException: true,
        streaming: true,
      },
    },
    {
      id: "CallActivity_RecordWorker",
      name: "Call record worker",
      type: "processCall",
      processId: "RecordWorker",
    },
    {
      id: "CallActivity_Gather",
      name: "Gather XML result envelopes",
      type: "gather",
      gather: { format: "xmlSame" },
    },
    {
      id: "CallActivity_BatchAudit",
      name: "Assert complete results and record MPL counts",
      type: "groovy",
      properties: { script: "SmartAuditBatch.groovy" },
    },
    { id: "EndEvent_Planned", name: "End", type: "end" },
  ];
  bp.edges = chain(bp.nodes, "Flow_");
  bp.exceptionHandler = {
    script: "SmartRecordFailure.groovy",
    name: "Record sanitized failure and preserve FAILED",
    end: "error",
  };
}
