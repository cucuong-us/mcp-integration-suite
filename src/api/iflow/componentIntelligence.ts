import { z } from "zod";
import { DOMParser, Element } from "@xmldom/xmldom";
import * as xpath from "xpath";
import {
  blueprintSchema,
  validateBlueprintGraph,
  ParsedBlueprint,
  Blueprint,
} from "./blueprintSchema";

type Rule = { useWhen: string; requires: string[]; avoid: string[] };
// Exhaustive: adding a schema node type requires a decision guide here too.
export const componentCatalog: Record<
  ParsedBlueprint["nodes"][number]["type"],
  Rule
> = {
  start: {
    useWhen: "Receive from exactly one configured trigger per process",
    requires: ["HTTPS endpoint, Timer schedule, or SFTP scheduler"],
    avoid: ["Timer plus SFTP as two independent starts"],
  },
  end: {
    useWhen: "Terminate a successful route",
    requires: ["Explicit error outcome in exception subprocess"],
    avoid: ["Treating MPL COMPLETED as backend business success"],
  },
  contentModifier: {
    useWhen: "Set body, headers or exchange properties declaratively",
    requires: ["SAP row/cell table for properties and headers"],
    avoid: [
      "Groovy solely to assign constants",
      "Secrets in constant header values",
    ],
  },
  groovy: {
    useWhen:
      "Bounded parsing, business rules or semantic assertions that native steps cannot express",
    requires: ["Bundled script", "Input limits and sanitized logging"],
    avoid: [
      "Replacing simple modifiers or mappings",
      "Assuming third-party libraries exist",
    ],
  },
  router: {
    useWhen: "Choose one route by an explicit XML or property condition",
    requires: ["Conditions", "Exactly one default route"],
    avoid: [
      "Using Router for parallel fan-out",
      "Ignoring HTTP error statuses",
    ],
  },
  xmlToJson: {
    useWhen: "Convert an XML structure to JSON",
    requires: [
      "XML input",
      "Agreed array, namespace and numeric representation",
    ],
    avoid: ["Calling this an XLSX converter"],
  },
  jsonToXml: {
    useWhen: "Convert JSON before XML mapping, validation or splitting",
    requires: ["Agreed XML root/namespace", "Representative arrays"],
    avoid: ["Splitting raw JSON using XML XPath"],
  },
  messageMapping: {
    useWhen: "Graphical field mapping against known source/target contracts",
    requires: ["Complete mmap and referenced schemas"],
    avoid: ["Inventing a backend IDoc schema"],
  },
  xsltMapping: {
    useWhen: "Declarative XML restructuring or mapping",
    requires: ["Bundled XSLT resource"],
    avoid: ["Assuming schema validity proves correct field values"],
  },
  xmlValidator: {
    useWhen: "Enforce an agreed XML structural contract",
    requires: ["Bundled XSD", "Fail on invalid input"],
    avoid: ["Using XSD as a substitute for live master-data checks"],
  },
  generalSplitter: {
    useWhen:
      "One operation per complete business record, retaining XML ancestors",
    requires: [
      "Record XPath",
      "Business unit",
      "Grouping/concurrency/error policy",
      "Sample proving record boundaries",
    ],
    avoid: [
      "Splitting PO item rows when one request creates a whole PO",
      "Assuming already posted records roll back when a later record fails",
    ],
  },
  gather: {
    useWhen: "Combine split responses, or combine branches after Join",
    requires: [
      "Matching input format and aggregation algorithm",
      "Complete-result/count assertion",
    ],
    avoid: [
      "Plain-text concatenation advertised as one valid XML document",
      "Assuming parallel timeout cannot drop split results",
    ],
  },
  multicast: {
    useWhen: "Independent branch operations may run concurrently",
    requires: ["Matching Join", "Independent side effects", "Named branches"],
    avoid: ["Branches that depend on each other's result"],
  },
  sequentialMulticast: {
    useWhen: "Fan-out branches must run in a known order",
    requires: ["Ordered named branches", "Matching Join"],
    avoid: ["Treating sequence as a distributed transaction"],
  },
  join: {
    useWhen: "Synchronize branches of one Multicast",
    requires: ["Owning Multicast"],
    avoid: ["Using Join to concatenate bodies", "Adding Join after a Splitter"],
  },
  processCall: {
    useWhen: "Reuse a synchronous local process or isolate a split worker",
    requires: [
      "Local process ID",
      "No recursion or cross-process sequence edges",
    ],
    avoid: ["Using this as an external API adapter"],
  },
  requestReply: {
    useWhen: "Synchronous HTTP or OData API call whose response is needed",
    requires: [
      "Endpoint/method",
      "Auth alias if required",
      "Timeout",
      "Response contract/error policy",
    ],
    avoid: [
      "Automatic replay of POST after ambiguous timeout",
      "Assuming HTTP 200 means business success",
    ],
  },
  send: {
    useWhen: "Deliver asynchronously to supported JMS or SFTP receiver",
    requires: ["Adapter destination and existing credentials"],
    avoid: [
      "Expecting a synchronous API response",
      "Claiming queue delivery proves downstream completion",
    ],
  },
};
export function getComponentCatalog() {
  return {
    scope:
      "All node types currently supported by this compiler, not all SAP palette components",
    components: componentCatalog,
    adapters: {
      senders: ["https", "timer", "sftp"],
      receivers: ["http", "odataV2", "jms", "sftp"],
    },
    unsupported: [
      "IDoc receiver",
      "JMS sender",
      "Iterating Splitter",
      "OData V4",
      "Data Store",
      "Mail",
      "ProcessDirect",
    ],
    workflow: [
      "Choose pattern and contracts",
      "Plan without guessing missing business inputs",
      "Analyze sample payload and risks",
      "Preview",
      "SAP validate",
      "Deploy once",
      "Verify runtime, correlated MPL and backend outcome",
    ],
  };
}
export const analysisContextSchema = z
  .object({
    inputFormat: z.enum(["xml", "json", "text", "unknown"]).default("unknown"),
    sampleXml: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict();
export type Issue = {
  severity: "error" | "warning";
  code: string;
  node?: string;
  message: string;
};
export function selectSample(
  xml: string,
  expression: string,
  namespaces: Record<string, string> = {},
): Element[] {
  if (Buffer.byteLength(xml) > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Sample must be bounded XML without DTD/entities");
  if (expression.length > 1000)
    throw new Error("Sample XPath exceeds supported length");
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (_level, message) => errors.push(message),
  }).parseFromString(xml, "application/xml");
  if (errors.length || !doc.documentElement)
    throw new Error("Malformed sample XML");
  const result = xpath.useNamespaces(namespaces)(expression, doc as any);
  if (!Array.isArray(result) || result.some((n) => n.nodeType !== 1))
    throw new Error(
      "Split XPath must select element records, not attributes or scalars",
    );
  return result as unknown as Element[];
}
export function analyzeParsedBlueprint(
  bp: ParsedBlueprint,
  context: z.input<typeof analysisContextSchema> = {},
) {
  const ctx = analysisContextSchema.parse(context),
    issues: Issue[] = [];
  const add = (
    severity: Issue["severity"],
    code: string,
    message: string,
    node?: string,
  ) => issues.push({ severity, code, message, node });
  const samples: Record<string, { records: number; groups: number }> = {};
  const graphs = [
    {
      id: "Process_1",
      nodes: bp.nodes,
      edges: bp.edges,
      exceptionHandler: bp.exceptionHandler,
    },
    ...bp.localProcesses,
  ];
  for (const graph of graphs) {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const reachable = (from: string) => {
      const seen = new Set([from]),
        queue = [from];
      while (queue.length) {
        const current = queue.shift();
        for (const e of graph.edges.filter((e) => e.source === current))
          if (!seen.has(e.target)) {
            seen.add(e.target);
            queue.push(e.target);
          }
      }
      return seen;
    };
    // Analyze all branch paths: an unrelated upstream Splitter must not authorize a Gather.
    const visited = new Set<string>();
    const joinStacks = new Map<string, string>();
    const visit = (
      id: string,
      stack: string[],
      format: string,
      path: Set<string>,
    ) => {
      if (path.has(id)) return;
      const state = JSON.stringify([id, stack, format]);
      if (visited.has(state)) return;
      if (visited.size >= 2000) {
        add(
          "error",
          "ANALYSIS_COMPLEXITY_LIMIT",
          "Reduce ambiguous nested split/branch states before compiling",
          id,
        );
        return;
      }
      visited.add(state);
      const n = nodes.get(id)!;
      let active = [...stack],
        out = format;
      if (n.type === "join") {
        const key = JSON.stringify(active);
        if (joinStacks.has(id) && joinStacks.get(id) !== key)
          add(
            "error",
            "UNBALANCED_SPLIT_BRANCHES",
            "Close branch-local Splitters before joining Multicast branches",
            n.id,
          );
        joinStacks.set(id, key);
      }
      if (
        n.type === "contentModifier" &&
        n.properties.bodyType === "constant"
      ) {
        const body = (n.properties.wrapContent || "").trim();
        out = body.startsWith("<")
          ? "xml"
          : /^[\[{]/.test(body)
            ? "json"
            : "text";
      }
      if (n.type === "groovy" || n.type === "processCall") out = "unknown";
      if (
        [
          "xmlToJson",
          "xsltMapping",
          "messageMapping",
          "xmlValidator",
          "generalSplitter",
        ].includes(n.type) &&
        format === "json"
      )
        add(
          "error",
          "XML_INPUT_REQUIRED",
          "Convert JSON to XML before this step",
          n.id,
        );
      if (n.type === "jsonToXml" && format === "xml")
        add(
          "error",
          "JSON_INPUT_REQUIRED",
          "This step requires JSON input",
          n.id,
        );
      if (n.type === "jsonToXml") out = "xml";
      if (n.type === "xmlToJson") out = "json";
      if (["xsltMapping", "messageMapping", "generalSplitter"].includes(n.type))
        out = "xml";
      if (
        n.type === "requestReply" &&
        n.receiver &&
        (!n.receiver.type || n.receiver.type === "http")
      )
        out = n.receiver.responseFormat;
      if (n.type === "generalSplitter") active.push(n.id);
      if (n.type === "gather") {
        if (active.length) active.pop();
        else if (
          !graph.edges.some(
            (e) => e.target === n.id && nodes.get(e.source)?.type === "join",
          )
        )
          add(
            "error",
            "UNPAIRED_GATHER",
            "Every path into Gather must pass through a matching Splitter or Join",
            n.id,
          );
        if (n.gather?.format === "xmlSame" && ["json", "text"].includes(format))
          add(
            "error",
            "GATHER_FORMAT_MISMATCH",
            "XML Gather requires XML results from each worker",
            n.id,
          );
        out = n.gather?.format === "xmlSame" ? "xml" : "unknown";
      }
      if (n.type === "end" && graph.id !== "Process_1" && active.length)
        add(
          "error",
          "LOCAL_SPLITTER_NOT_CLOSED",
          "Close Splitters inside a local process with Gather",
          n.id,
        );
      for (const e of graph.edges.filter((e) => e.source === id))
        visit(e.target, active, out, new Set([...path, id]));
    };
    visit(
      graph.nodes.find((n) => n.type === "start")!.id,
      [],
      graph.id === "Process_1" ? ctx.inputFormat : "unknown",
      new Set(),
    );
    for (const n of graph.nodes) {
      if (n.type === "generalSplitter") {
        if (!n.splitter)
          add(
            "warning",
            "RAW_SPLITTER_CONFIG",
            "Declare typed splitter businessUnit, recordElement and execution policy",
            n.id,
          );
        const expression = n.properties.splitExprValue;
        for (const match of expression.matchAll(
          /\b([A-Za-z_][\w.-]*):[A-Za-z_]/g,
        ))
          if (!bp.namespaces[match[1]])
            add(
              "error",
              "UNBOUND_XPATH_NAMESPACE",
              "Define runtime namespace mapping for prefix " + match[1],
              n.id,
            );
        if (
          !/^\/(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*(?:\/(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)+$/.test(
            expression,
          )
        )
          add(
            "warning",
            "REVIEW_SPLIT_XPATH",
            "Prefer a concrete child-element XPath; complex predicates/functions are not certified by this template",
            n.id,
          );
        const downstream = [...reachable(n.id)].map((id) => nodes.get(id)!);
        if (n.properties.ParallelProcessing === "true")
          add(
            "warning",
            "PARALLEL_PARTIAL_RESULTS",
            "Splitter timeout may yield incomplete Gather results; assert expected result count and assess ordering/rate limits",
            n.id,
          );
        const handlers = [
          graph.exceptionHandler,
          ...downstream
            .filter((d) => d.type === "processCall")
            .map(
              (d) =>
                bp.localProcesses.find((local) => local.id === d.processId)
                  ?.exceptionHandler,
            ),
        ].filter(Boolean);
        if (
          n.properties.StopOnExecution !== "false" &&
          handlers.some((h) => h!.end !== "error")
        )
          add(
            "error",
            "SPLITTER_ERROR_SWALLOWED",
            "Stop on Exception requires Error End in main and called worker exception handlers",
            n.id,
          );
        if (n.properties.StopOnExecution === "false")
          add(
            "warning",
            "PARTIAL_SUCCESS_POLICY",
            "Define per-record error responses and reconciliation; a COMPLETED batch may contain failures",
            n.id,
          );
        if (
          downstream.some(
            (d) => d.type === "requestReply" || d.type === "processCall",
          )
        )
          add(
            "warning",
            "PARTIAL_SIDE_EFFECTS",
            "Earlier successful calls are not rolled back when a later record fails; reconcile by stable business keys",
            n.id,
          );
        if (ctx.sampleXml && graph.id === "Process_1")
          try {
            const records = selectSample(
              ctx.sampleXml,
              expression,
              bp.namespaces,
            );
            if (!records.length)
              add(
                "error",
                "EMPTY_SPLIT_SAMPLE",
                "Split XPath selects no records in sample",
                n.id,
              );
            if (
              n.splitter &&
              records.some((r) => r.localName !== n.splitter!.recordElement)
            )
              add(
                "error",
                "SPLIT_BUSINESS_UNIT_MISMATCH",
                "XPath selects a different element than the declared complete business record",
                n.id,
              );
            samples[n.id] = {
              records: records.length,
              groups: Math.ceil(
                records.length / Number(n.properties.grouping || 1),
              ),
            };
          } catch (e) {
            add("error", "INVALID_SPLIT_SAMPLE", (e as Error).message, n.id);
          }
      }
      if (n.type === "gather" && (!n.gather || n.gather.format === "text"))
        add(
          "warning",
          "GATHER_TEXT_CONCATENATION",
          "Plain text concatenation does not guarantee valid XML/JSON; choose an explicit output contract",
          n.id,
        );
      if (
        n.type === "requestReply" &&
        n.receiver &&
        (!n.receiver.type || n.receiver.type === "http")
      ) {
        const r = n.receiver;
        if (r.authentication.type === "none")
          add(
            "warning",
            "UNAUTHENTICATED_RECEIVER",
            "Confirm that this endpoint intentionally permits unauthenticated requests",
            n.id,
          );
        if (r.responseFormat === "unknown")
          add(
            "warning",
            "MISSING_RESPONSE_CONTRACT",
            "Declare expected response format and validate business fields after the call",
            n.id,
          );
        if (r.appendRecordKeyToPath)
          add(
            "warning",
            "VALIDATE_DYNAMIC_PATH_KEY",
            "X-Smart-Key must be a validated non-traversal business key; the split-api pattern supplies this guard",
            n.id,
          );
        if (!["GET", "HEAD"].includes(r.method))
          add(
            "warning",
            "WRITE_RECONCILIATION_REQUIRED",
            "No automatic retry is generated. Timeouts may leave an unknown backend outcome; use receiver-enforced idempotency and reconciliation",
            n.id,
          );
        if (r.method === "POST" && new URL(r.url).search)
          add(
            "warning",
            "POST_QUERY_SEMANTICS",
            "Review SAP HTTP adapter handling of POST query parameters and the request body contract",
            n.id,
          );
        if (r.errorHandling === "route") {
          const next = graph.edges
            .filter((e) => e.source === n.id)
            .map((e) => nodes.get(e.target)!);
          if (!next.some((x) => x.type === "router"))
            add(
              "error",
              "UNHANDLED_HTTP_STATUS",
              "errorHandling=route requires an immediate Router with an explicit failure route",
              n.id,
            );
          else
            add(
              "warning",
              "REVIEW_HTTP_STATUS_ROUTES",
              "Verify Router conditions cover non-success responses; default route alone does not prove correct handling",
              n.id,
            );
        }
      }
      if (n.type === "requestReply" && n.receiver?.type === "odataV2")
        add(
          "warning",
          "ODATA_PAGING_AND_CSRF",
          "Review pagination, XML payload contract and CSRF for writes; these are not automatically inferred",
          n.id,
        );
      if (n.type === "send")
        add(
          "warning",
          "DELIVERY_NOT_BUSINESS_COMPLETION",
          "Adapter delivery is separate from downstream business success",
          n.id,
        );
      if (n.type === "groovy")
        add(
          "warning",
          "CUSTOM_CODE_CONTRACT",
          "Review bounds, library availability and payload logging in the supplied script",
          n.id,
        );
      if (n.type === "processCall") {
        const local = bp.localProcesses.find((p) => p.id === n.processId);
        if (
          local?.nodes.some((step) => step.type === "requestReply") &&
          !local.exceptionHandler
        )
          add(
            "warning",
            "LOCAL_WORKER_ERROR_HANDLER",
            "Define an exception handler in the worker's own process scope; a main-process handler may not handle worker errors",
            n.id,
          );
      }
    }
  }
  const unique = issues.filter(
    (v, i, a) =>
      a.findIndex((x) => x.code === v.code && x.node === v.node) === i,
  );
  return {
    valid: !unique.some((i) => i.severity === "error"),
    issues: unique,
    samples,
    coveredComponents: [
      ...new Set(graphs.flatMap((g) => g.nodes.map((n) => n.type))),
    ],
    runtimeVerified: false,
    backendVerified: false,
  };
}
export function analyzeBlueprint(
  input: Blueprint,
  context: z.input<typeof analysisContextSchema> = {},
) {
  const bp = blueprintSchema.parse(input);
  validateBlueprintGraph(bp);
  return analyzeParsedBlueprint(bp, context);
}
