import { z } from "zod";
import { DOMParser } from "@xmldom/xmldom";

export const safeId = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(120);
const receiverName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
const alias = z.string().regex(/^[A-Za-z0-9_.-]+$/);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Requires HTTPS with no embedded credentials");
const sftpFields = {
  host: z.string().regex(/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/),
  directory: z.string().min(1),
  fileName: z.string().min(1),
  credentialName: alias,
};
const headerName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  .refine(
    (v) =>
      !/^(authorization|host|content-length|connection|camel.*|org\.apache\.camel.*)$/i.test(
        v,
      ),
    "Use adapter authentication; do not forward authorization, routing or protocol headers",
  );
export const httpReceiver = z
  .object({
    type: z.literal("http").optional(),
    url: httpsUrl,
    method: z
      .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
      .default("GET"),
    name: receiverName.default("HTTPReceiver"),
    authentication: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("none") }).strict(),
        z.object({ type: z.literal("basic"), credentialName: alias }).strict(),
        z
          .object({
            type: z.literal("oauth2ClientCredentials"),
            credentialName: alias,
          })
          .strict(),
      ])
      .default({ type: "none" }),
    timeoutMs: z.number().int().min(1).max(300000).default(60000),
    requestHeaders: z.array(headerName).max(30).default([]),
    responseHeaders: z.array(headerName).max(30).default([]),
    errorHandling: z.enum(["throw", "route"]).default("throw"),
    responseFormat: z
      .enum(["xml", "json", "text", "unknown"])
      .default("unknown"),
    sendBody: z.boolean().optional(),
    appendRecordKeyToPath: z.boolean().default(false),
  })
  .strict();
const receiverSchema = z.union([
  httpReceiver,
  z
    .object({
      type: z.literal("jms"),
      queue: alias,
      name: receiverName.default("JMSReceiver"),
    })
    .strict(),
  z
    .object({
      type: z.literal("sftp"),
      ...sftpFields,
      name: receiverName.default("SFTPReceiver"),
    })
    .strict(),
  z
    .object({
      type: z.literal("odataV2"),
      url: httpsUrl,
      resourcePath: z.string().min(1),
      operation: z
        .enum([
          "Query(GET)",
          "Read(GET)",
          "Create(POST)",
          "Update(PUT)",
          "Delete(DELETE)",
        ])
        .default("Query(GET)"),
      queryOptions: z.string().default(""),
      edmx: z.string().regex(/^src\/main\/resources\/edmx\/.+\.edmx$/),
      credentialName: alias.optional(),
      name: receiverName.default("ODataReceiver"),
    })
    .strict(),
]);
export const nodeSchema = z
  .object({
    id: safeId,
    name: z.string().min(1),
    type: z.enum([
      "start",
      "end",
      "contentModifier",
      "groovy",
      "router",
      "xmlToJson",
      "messageMapping",
      "xsltMapping",
      "xmlValidator",
      "requestReply",
      "generalSplitter",
      "gather",
      "multicast",
      "sequentialMulticast",
      "join",
      "jsonToXml",
      "processCall",
      "send",
    ]),
    receiver: receiverSchema.optional(),
    processId: safeId.optional(),
    joinId: safeId.optional(),
    properties: z.record(z.string()).default({}),
    splitter: z
      .object({
        xpath: z.string().min(1).max(1000),
        businessUnit: z.string().min(1).max(100),
        recordElement: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
        grouping: z.number().int().min(1).max(1000).default(1),
        parallel: z.boolean().default(false),
        concurrency: z.number().int().min(1).max(50).default(1),
        timeoutSeconds: z.number().int().min(1).max(3600).default(300),
        stopOnException: z.boolean().default(true),
        streaming: z.boolean().default(true),
      })
      .strict()
      .optional(),
    gather: z
      .object({ format: z.enum(["text", "xmlSame"]) })
      .strict()
      .optional(),
    x: z.number().finite().nonnegative().optional(),
    y: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const edgeSchema = z
  .object({
    id: safeId,
    name: z.string().min(1).optional(),
    source: safeId,
    target: safeId,
    condition: z.string().optional(),
    default: z.boolean().default(false),
    expressionType: z.enum(["XML", "NonXML"]).default("NonXML"),
  })
  .strict();
const graph = {
  nodes: z.array(nodeSchema).min(2).max(100),
  edges: z.array(edgeSchema).min(1).max(200),
};
export const exceptionHandlerSchema = z
  .object({
    script: z.string().regex(/^[A-Za-z0-9_.-]+\.groovy$/),
    name: z.string().default("Handle Exception"),
    end: z.enum(["message", "error"]).default("message"),
  })
  .strict();

export const blueprintSchema = z
  .object({
    id: safeId,
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z_][A-Za-z0-9_. -]*$/)
      .refine(
        (n) => !n.endsWith(".") && n === n.trim(),
        "Invalid SAP artifact name",
      ),
    endpoint: z
      .string()
      .regex(/^\/[A-Za-z0-9_./-]+$/)
      .optional(),
    sender: z
      .union([
        z.object({ type: z.literal("https") }).strict(),
        z
          .object({
            type: z.literal("timer"),
            runOnce: z.literal(true).optional(),
            scheduleKey: z.string().min(1).optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal("sftp"),
            ...sftpFields,
            postProcessing: z.literal("delete"),
            scheduleKey: z.string().min(1),
          })
          .strict(),
      ])
      .default({ type: "https" }),
    csrfProtected: z.boolean().default(true),
    namespaces: z
      .record(
        z.string().regex(/^(?!xml$|xmlns$)[A-Za-z_][A-Za-z0-9_]*$/),
        z
          .string()
          .url()
          .refine((v) => !/[;\s<>"']/.test(v)),
      )
      .default({}),
    allowedHeaders: z
      .array(z.string().regex(/^[A-Za-z0-9_-]+$/))
      .default(["SAP_ApplicationID"]),
    ...graph,
    localProcesses: z
      .array(
        z
          .object({
            id: safeId,
            name: z.string().min(1),
            ...graph,
            exceptionHandler: exceptionHandlerSchema.optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    resources: z
      .array(
        z
          .object({
            path: z.string().regex(/^src\/main\/resources\//),
            content: z.string(),
          })
          .strict(),
      )
      .default([]),
    exceptionHandler: exceptionHandlerSchema.optional(),
  })
  .strict();
export type Blueprint = z.input<typeof blueprintSchema>;
export type ParsedBlueprint = z.output<typeof blueprintSchema>;

/** Checks scopes and structured branch convergence before generating any XML. */
export function validateBlueprintGraph(bp: ParsedBlueprint) {
  for (const graph of [bp, ...bp.localProcesses])
    for (const node of graph.nodes) {
      if (node.splitter) {
        if (node.type !== "generalSplitter")
          throw new Error("splitter options require generalSplitter");
        const s = node.splitter;
        // SAP validates the dormant thread field as 2..50 even for sequential splitting.
        const typed = {
          splitExprValue: s.xpath,
          exprType: "XPath",
          grouping: String(s.grouping),
          ParallelProcessing: String(s.parallel),
          SplitterThreads: String(s.parallel ? s.concurrency : 2),
          timeOut: String(s.timeoutSeconds),
          StopOnExecution: String(s.stopOnException),
          Streaming: String(s.streaming),
        };
        for (const [key, value] of Object.entries(typed)) {
          if (
            node.properties[key] !== undefined &&
            node.properties[key] !== value
          )
            throw new Error("Conflicting typed Splitter property: " + key);
          node.properties[key] = value;
        }
        if (!s.parallel && s.concurrency !== 1)
          throw new Error("Sequential splitter requires concurrency=1");
        if (s.parallel && s.concurrency < 2)
          throw new Error("Parallel splitter requires concurrency >= 2");
      }
      if (node.gather) {
        if (node.type !== "gather")
          throw new Error("gather options require gather step");
        const typed =
          node.gather.format === "xmlSame"
            ? {
                messageType: "SameXMLFormat",
                aggregationAlgorithm: "sap-identical-multi-mapping",
              }
            : {
                messageType: "PlainText",
                aggregationAlgorithm: "concatenate-strategy",
              };
        for (const [key, value] of Object.entries(typed)) {
          if (
            node.properties[key] !== undefined &&
            node.properties[key] !== value
          )
            throw new Error("Conflicting typed Gather property: " + key);
          node.properties[key] = value;
        }
      }
    }
  if (
    bp.sender.type === "timer" &&
    (bp.sender.runOnce === true) === !!bp.sender.scheduleKey
  )
    throw new Error(
      "Timer requires exactly one of runOnce=true or an exported scheduleKey",
    );
  if (bp.sender.type !== "https" && bp.sender.scheduleKey) {
    const schedule = bp.sender.scheduleKey;
    if (/<!DOCTYPE|<!ENTITY/i.test(schedule))
      throw new Error("Unsafe scheduler XML");
    const errors: string[] = [];
    let doc;
    try {
      doc = new DOMParser({
        onError: (_level, message) => {
          errors.push(message);
        },
      }).parseFromString(
        "<schedule>" + schedule + "</schedule>",
        "application/xml",
      );
    } catch {
      throw new Error("Invalid scheduler XML");
    }
    const rows = Array.from(doc.getElementsByTagName("row"));
    const values = new Map(
      rows.map((row) => [
        row.getElementsByTagName("cell")[0]?.textContent,
        row.getElementsByTagName("cell")[1]?.textContent,
      ]),
    );
    if (
      errors.length ||
      !rows.length ||
      rows.some((row) => row.getElementsByTagName("cell").length !== 2) ||
      !values.get("schedule1") ||
      !values.get("triggerType")
    )
      throw new Error(
        "Use an exported SAP scheduler row/cell table with triggerType and schedule1",
      );
  }
  if (bp.sender.type === "https" && !bp.endpoint)
    throw new Error("HTTPS sender requires endpoint");
  if (bp.sender.type !== "https" && bp.endpoint)
    throw new Error("endpoint is only supported for HTTPS sender");
  const graphs = [
    { id: "Process_1", nodes: bp.nodes, edges: bp.edges },
    ...bp.localProcesses,
  ];
  const ids = graphs.flatMap((g) => [
    g.id,
    ...g.nodes.map((n) => n.id),
    ...g.edges.map((e) => e.id),
  ]);
  if (new Set(ids).size !== ids.length)
    throw new Error("Node/edge/process IDs must be unique");
  if (
    ids
      .filter((id) => id !== "Process_1")
      .some(
        (id) =>
          [
            "Definitions_1",
            "Collaboration_1",
            "Participant_1",
            "Participant_Process_1",
            "MessageFlow_4",
            "BPMNDiagram_1",
            "BPMNPlane_1",
          ].includes(id) ||
          /^(DI_|Exception_|Receiver_|Channel_|Condition_|Local_|Timer_|TimerEventDefinition_|(?:SubProcess|StartEvent|EndEvent|CallActivity|SequenceFlow)_Exception|(?:Process|StartEvent|EndEvent|CallActivity|ServiceTask|ExclusiveGateway|ParallelGateway|SequenceFlow)_Local_)/.test(
            id,
          ),
      )
  )
    throw new Error("Reserved diagram ID");
  if (
    graphs.reduce((sum, g) => sum + g.nodes.length, 0) > 100 ||
    graphs.reduce((sum, g) => sum + g.edges.length, 0) > 200
  )
    throw new Error("Global graph limits exceeded");
  const locals = new Map(bp.localProcesses.map((p) => [p.id, p]));
  const visitCalls = (id: string, stack: Set<string>) => {
    if (stack.has(id)) throw new Error("Recursive local process call: " + id);
    const graph = graphs.find((g) => g.id === id)!;
    for (const n of graph.nodes.filter((n) => n.type === "processCall")) {
      if (!n.processId || !locals.has(n.processId))
        throw new Error("Unknown local process: " + n.processId);
      visitCalls(n.processId, new Set([...stack, id]));
    }
  };
  for (const graph of graphs) visitCalls(graph.id, new Set());
  for (const g of graphs) {
    const nodes = new Map(g.nodes.map((n) => [n.id, n]));
    const starts = g.nodes.filter((n) => n.type === "start"),
      ends = g.nodes.filter((n) => n.type === "end");
    if (starts.length !== 1 || !ends.length)
      throw new Error("One start and at least one end are required: " + g.id);
    for (const e of g.edges)
      if (!nodes.has(e.source) || !nodes.has(e.target))
        throw new Error("Edge references unknown node in process: " + e.id);
    const walk = (seed: string[], reverse = false, stop?: string) => {
      const seen = new Set(seed),
        queue = [...seed];
      while (queue.length) {
        const id = queue.shift()!;
        if (id === stop) continue;
        for (const e of g.edges)
          if ((reverse ? e.target : e.source) === id) {
            const to = reverse ? e.source : e.target;
            if (!seen.has(to)) {
              seen.add(to);
              queue.push(to);
            }
          }
      }
      return seen;
    };
    if (
      walk([starts[0].id]).size !== g.nodes.length ||
      walk(
        ends.map((n) => n.id),
        true,
      ).size !== g.nodes.length
    )
      throw new Error(
        "Invalid connections: all nodes must be reachable and have a path to an end",
      );
    // Cyclic graphs need loop-specific components and are deliberately rejected here.
    const active = new Set<string>(),
      done = new Set<string>();
    const cycle = (id: string) => {
      if (active.has(id)) throw new Error("Sequence flow cycle: " + id);
      if (done.has(id)) return;
      active.add(id);
      for (const e of g.edges.filter((e) => e.source === id)) cycle(e.target);
      active.delete(id);
      done.add(id);
    };
    cycle(starts[0].id);
    for (const n of g.nodes) {
      const outgoing = g.edges.filter((e) => e.source === n.id),
        incoming = g.edges.filter((e) => e.target === n.id);
      if (
        n.type === "start"
          ? incoming.length !== 0 || outgoing.length !== 1
          : n.type === "end"
            ? outgoing.length !== 0 || !incoming.length
            : !incoming.length || !outgoing.length
      )
        throw new Error("Invalid connections for " + n.id);
      if (n.type === "router") {
        if (
          outgoing.length < 2 ||
          outgoing.filter((e) => e.default).length !== 1 ||
          outgoing.some((e) => !e.default && !e.condition)
        )
          throw new Error(
            "Router requires one default and conditions for other branches: " +
              n.id,
          );
      } else if (["multicast", "sequentialMulticast"].includes(n.type)) {
        if (
          incoming.length !== 1 ||
          outgoing.length < 2 ||
          !n.joinId ||
          nodes.get(n.joinId)?.type !== "join"
        )
          throw new Error("Multicast requires branches and a joinId: " + n.id);
        const join = n.joinId;
        const branchSets = outgoing.map((e) => walk([e.target], false, join));
        if (branchSets.some((set) => !set.has(join)))
          throw new Error("Every multicast branch must reach its Join");
        for (const branch of branchSets)
          for (const id of branch) {
            if (id === join) continue;
            const next = g.edges.filter((e) => e.source === id);
            if (!next.length || next.some((e) => !branch.has(e.target)))
              throw new Error("Multicast branch bypasses Join");
          }
        for (let i = 0; i < branchSets.length; i++)
          for (let j = i + 1; j < branchSets.length; j++)
            if (
              [...branchSets[i]].some(
                (id) => id !== join && branchSets[j].has(id),
              )
            )
              throw new Error("Multicast branches merge before their Join");
        if (g.edges.filter((e) => e.target === join).length !== outgoing.length)
          throw new Error("Join incoming count must match multicast branches");
      } else if (n.type !== "end" && outgoing.length !== 1)
        throw new Error("Use router or multicast for branching: " + n.id);
      if (
        n.type === "join" &&
        (incoming.length < 2 ||
          g.nodes.filter((m) => m.joinId === n.id).length !== 1)
      )
        throw new Error("Join requires exactly one owning multicast");
      if (n.type !== "join" && n.type !== "end" && incoming.length > 1)
        throw new Error("Use a Join to merge parallel branches: " + n.id);
      if (outgoing.some((e) => e.default || e.condition) && n.type !== "router")
        throw new Error("Conditions/default only supported on router edges");
      if (n.joinId && !["multicast", "sequentialMulticast"].includes(n.type))
        throw new Error("joinId only supported on multicast");
      if (n.processId && n.type !== "processCall")
        throw new Error("processId only supported on processCall");
      if (["requestReply", "send"].includes(n.type) !== !!n.receiver)
        throw new Error(
          "Receiver configuration required only for requestReply or send: " +
            n.id,
        );
      if (n.receiver) {
        const config = n.receiver,
          type = config.type || "http";
        if ((type === "jms" || type === "sftp") !== (n.type === "send"))
          throw new Error(
            "JMS/SFTP require send; HTTP/OData require requestReply",
          );
        if (
          config.type === "odataV2" &&
          !bp.resources.some((r) => r.path === config.edmx)
        )
          throw new Error("OData metadata resource not found");
      }
      if (n.type === "generalSplitter" && !n.properties.splitExprValue?.trim())
        throw new Error("Splitter requires splitExprValue");
      if (n.type === "xsltMapping") {
        const uri = n.properties.mappinguri || "";
        const resource = uri.replace(/^dir:\/\/mapping\/xslt\//, "");
        if (
          !/^dir:\/\/mapping\/xslt\/src\/main\/resources\/mapping\/[A-Za-z0-9_.-]+\.xslt?$/.test(
            uri,
          ) ||
          !bp.resources.some((r) => r.path === resource)
        )
          throw new Error(
            "XSLT Mapping requires a bundled mappinguri resource",
          );
        if (
          n.properties.mappingSource &&
          n.properties.mappingSource !== "mappingSrcIflow"
        )
          throw new Error("Only bundled XSLT mappings are supported");
      }
      if (n.type === "xmlValidator") {
        const resource = n.properties.xsd || "";
        if (
          !/^\/xsd\/[A-Za-z0-9_.-]+\.xsd$/.test(resource) ||
          !bp.resources.some((r) => r.path === "src/main/resources" + resource)
        )
          throw new Error("XML Validator requires a bundled /xsd resource");
        if (
          (n.properties.preventException &&
            n.properties.preventException !== "false") ||
          (n.properties.xmlSchemaSource &&
            n.properties.xmlSchemaSource !== "iflowOption")
        )
          throw new Error(
            "XML Validator must fail on invalid input and use a bundled schema",
          );
      }
      if (
        n.type === "gather" &&
        !incoming.some((e) => nodes.get(e.source)?.type === "join") &&
        !g.nodes.some(
          (s) => s.type === "generalSplitter" && walk([s.id]).has(n.id),
        )
      )
        throw new Error("Gather requires upstream Splitter or Join");
    }
  }
}
