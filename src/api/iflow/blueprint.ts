import { DOMParser, XMLSerializer, Element } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { globSync } from "glob";
import { elements, requireValidDesign } from "../../utils/designValidation";
const B = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const D = "http://www.omg.org/spec/BPMN/20100524/DI";
const C = "http://www.omg.org/spec/DD/20100524/DC";
const I = "http://www.omg.org/spec/DD/20100524/DI";
const F = "http:///com.sap.ifl.model/Ifl.xsd";
const root = path.resolve(__dirname, "../../../resources");
function foldManifest(text: string): string {
  return (
    text
      .replace(/\r?\n /g, "")
      .split(/\r?\n/)
      .map((line) => {
        const lines: string[] = [];
        let current = "";
        for (const char of line) {
          if (Buffer.byteLength(current + char, "utf8") > 70) {
            lines.push(current);
            current = " ";
          }
          current += char;
        }
        lines.push(current);
        return lines.join("\r\n");
      })
      .join("\r\n")
      .replace(/\r\n*$/, "") + "\r\n\r\n"
  );
}
import {
  blueprintSchema,
  Blueprint,
  validateBlueprintGraph,
} from "./blueprintSchema";
export { blueprintSchema } from "./blueprintSchema";
export type { Blueprint } from "./blueprintSchema";
const extendedTemplates: Record<
  string,
  { tag: string; properties: Record<string, string> }
> = JSON.parse(
  readFileSync(path.join(root, "component-templates/extended.json"), "utf8"),
);
const donors: Record<string, [string, string]> = {
  start: ["helpers/if_echo_mapping/**/*.iflw", "StartEvent_2"],
  end: ["helpers/if_echo_mapping/**/*.iflw", "EndEvent_2"],
  contentModifier: ["helpers/if_echo_mapping/**/*.iflw", "CallActivity_8"],
  messageMapping: ["helpers/if_echo_mapping/**/*.iflw", "CallActivity_5"],
  groovy: [
    "examples/iflows/if_google_ads_campaigns/**/*.iflw",
    "CallActivity_554844",
  ],
  router: [
    "examples/iflows/if_fwd_google_request/**/*.iflw",
    "ExclusiveGateway_8",
  ],
  xmlToJson: [
    "examples/iflows/Replicate_product_inventory_info/**/*.iflw",
    "CallActivity_11",
  ],
  route: ["examples/iflows/if_fwd_google_request/**/*.iflw", "SequenceFlow_12"],
  requestReply: [
    "examples/iflows/if_fwd_google_request/**/*.iflw",
    "ServiceTask_11",
  ],
  httpReceiver: [
    "examples/iflows/if_http_server_to_http_request/**/*.iflw",
    "MessageFlow_5",
  ],
  receiverParticipant: [
    "examples/iflows/if_http_server_to_http_request/**/*.iflw",
    "Participant_2",
  ],
  exception: [
    "examples/iflows/if_google_ads_campaigns/**/*.iflw",
    "SubProcess_456",
  ],
  localStart: [
    "examples/iflows/if_google_ads_campaigns/**/*.iflw",
    "StartEvent_554893",
  ],
  localEnd: [
    "examples/iflows/if_google_ads_campaigns/**/*.iflw",
    "EndEvent_554894",
  ],
  errorStart: [
    "examples/iflows/if_google_ads_campaigns/**/*.iflw",
    "StartEvent_457",
  ],
};
function donor(type: string): Element {
  if (extendedTemplates[type]) {
    const template = extendedTemplates[type];
    const doc = new DOMParser().parseFromString(
      `<bpmn2:${template.tag} xmlns:bpmn2="${B}" xmlns:ifl="${F}"><bpmn2:extensionElements/></bpmn2:${template.tag}>`,
      "application/xml",
    );
    const ext = doc.documentElement!.firstChild!;
    for (const [key, value] of Object.entries(template.properties)) {
      const p = doc.createElementNS(F, "ifl:property"),
        k = doc.createElement("key"),
        v = doc.createElement("value");
      k.textContent = key;
      v.textContent = value;
      p.appendChild(k);
      p.appendChild(v);
      ext.appendChild(p);
    }
    return doc.documentElement!;
  }
  const [pattern, id] = donors[type];
  const files = globSync(pattern, { cwd: root, absolute: true });
  if (files.length !== 1)
    throw new Error("Component template is missing or ambiguous: " + type);
  const doc = new DOMParser().parseFromString(
    readFileSync(files[0], "utf8"),
    "application/xml",
  );
  const e = doc.getElementById(id);
  if (!e) throw new Error("Missing template node: " + id);
  return e;
}
export function compileBlueprint(input: Blueprint) {
  const bp = blueprintSchema.parse(input);
  validateBlueprintGraph(bp);
  // SAP validation accepted arbitrary IDs but the tested tenant emitted an
  // empty local Camel route. Follow the naming used by exported SAP models.
  const idMap = new Map<string, string>();
  for (const local of bp.localProcesses) {
    idMap.set(local.id, "Process_Local_" + local.id);
    for (const node of local.nodes) {
      const prefix =
        node.type === "start"
          ? "StartEvent"
          : node.type === "end"
            ? "EndEvent"
            : node.type === "router"
              ? "ExclusiveGateway"
              : ["multicast", "sequentialMulticast", "join"].includes(node.type)
                ? "ParallelGateway"
                : ["send", "requestReply"].includes(node.type)
                  ? "ServiceTask"
                  : "CallActivity";
      idMap.set(node.id, prefix + "_Local_" + node.id);
    }
    for (const edge of local.edges)
      idMap.set(edge.id, "SequenceFlow_Local_" + edge.id);
  }
  for (const graph of [
    { id: "Process_1", nodes: bp.nodes, edges: bp.edges },
    ...bp.localProcesses,
  ]) {
    graph.id = idMap.get(graph.id) || graph.id;
    for (const node of graph.nodes) {
      node.id = idMap.get(node.id) || node.id;
      if (node.processId)
        node.processId = idMap.get(node.processId) || node.processId;
      if (node.joinId) node.joinId = idMap.get(node.joinId) || node.joinId;
    }
    for (const edge of graph.edges) {
      edge.id = idMap.get(edge.id) || edge.id;
      edge.source = idMap.get(edge.source) || edge.source;
      edge.target = idMap.get(edge.target) || edge.target;
    }
  }
  const graphs = [
    { id: "Process_1", name: bp.name, nodes: bp.nodes, edges: bp.edges },
    ...bp.localProcesses,
  ];
  const allNodes = graphs.flatMap((g) => g.nodes);
  const allEdges = graphs.flatMap((g) => g.edges);
  const nodes = new Map(allNodes.map((n) => [n.id, n]));
  const owner = new Map(
    graphs.flatMap((g) => g.nodes.map((n) => [n.id, g.id] as const)),
  );
  const starts = bp.nodes.filter((n) => n.type === "start");
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(root, "helpers/if_echo_mapping"));
  const modelPath =
    "src/main/resources/scenarioflows/integrationflow/if_echo_mapping.iflw";
  const doc = new DOMParser().parseFromString(
    zip.readAsText(modelPath),
    "application/xml",
  );
  const process = elements(doc, B, "process")[0];
  for (const child of Array.from(process.childNodes))
    if ((child as Element).localName !== "extensionElements")
      process.removeChild(child);
  const make = (
    ns: string,
    tag: string,
    attrs: Record<string, string | number>,
    parent?: Element,
  ) => {
    const e = doc.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent?.appendChild(e);
    return e;
  };
  const property = (node: Element, key: string, value: string) => {
    let ext = Array.from(node.childNodes).find(
      (n) => (n as Element).localName === "extensionElements",
    ) as Element | undefined;
    if (!ext) {
      ext = make(B, "bpmn2:extensionElements", {});
      node.insertBefore(ext, node.firstChild);
    }
    let prop = elements(ext, F, "property").find(
      (p) => p.getElementsByTagName("key")[0]?.textContent === key,
    );
    if (!prop) {
      prop = make(F, "ifl:property", {}, ext);
      const k = make("", "key", {}, prop);
      k.textContent = key;
      make("", "value", {}, prop);
    }
    prop.getElementsByTagName("value")[0].textContent = value;
  };
  const collaboration = elements(doc, B, "collaboration")[0];
  const processes = new Map<string, Element>([["Process_1", process]]);
  for (const local of bp.localProcesses) {
    const p = doc.importNode(donor("localProcess"), true) as Element;
    p.setAttribute("id", local.id);
    p.setAttribute("name", local.name);
    doc.documentElement!.insertBefore(p, process.nextSibling);
    processes.set(local.id, p);
    const pool = doc.importNode(
      elements(doc, B, "participant").find(
        (e) => e.getAttribute("id") === "Participant_Process_1",
      )!,
      true,
    ) as Element;
    pool.setAttribute("id", "Local_" + local.id);
    pool.setAttribute("name", local.name);
    pool.setAttribute("processRef", local.id);
    collaboration.appendChild(pool);
  }
  const nodeElements = new Map<string, Element>();
  for (const n of allNodes) {
    const e = doc.importNode(
      donor(
        n.type === "start" &&
          (owner.get(n.id) !== "Process_1" || bp.sender.type === "timer")
          ? "localStart"
          : n.type === "end" &&
              (owner.get(n.id) !== "Process_1" || bp.sender.type !== "https")
            ? "localEnd"
            : n.type,
      ),
      true,
    ) as Element;
    e.setAttribute("id", n.id);
    e.setAttribute("name", n.name);
    e.removeAttribute("default");
    for (const child of Array.from(e.childNodes))
      if (["incoming", "outgoing"].includes((child as Element).localName || ""))
        e.removeChild(child);
    if (n.type === "groovy") property(e, "scriptBundleId", "");
    if (n.type === "processCall") property(e, "processId", n.processId!);
    if (n.type === "sequentialMulticast")
      property(
        e,
        "routingSequenceTable",
        allEdges
          .filter((f) => f.source === n.id)
          .map((f, i) => `<row><cell>${i + 1}</cell><cell>${f.id}</cell></row>`)
          .join(""),
      );
    if (
      n.type === "start" &&
      owner.get(n.id) === "Process_1" &&
      bp.sender.type === "timer"
    ) {
      const timer = doc.importNode(donor("timerDefinition"), true) as Element;
      timer.setAttribute("id", "Timer_" + n.id);
      if (bp.sender.scheduleKey)
        property(timer, "scheduleKey", bp.sender.scheduleKey);
      e.appendChild(timer);
    }
    for (const [key, value] of Object.entries(n.properties)) {
      if (
        [
          "cmdVariantUri",
          "componentVersion",
          "activityType",
          "subActivityType",
          "processId",
          "routingSequenceTable",
          "scheduleKey",
        ].includes(key)
      )
        throw new Error("Component identity cannot be overridden: " + key);
      property(e, key, value);
    }
    for (const edge of allEdges) {
      if (edge.target === n.id)
        make(B, "bpmn2:incoming", {}, e).textContent = edge.id;
      if (edge.source === n.id)
        make(B, "bpmn2:outgoing", {}, e).textContent = edge.id;
      if (edge.source === n.id && edge.default)
        e.setAttribute("default", edge.id);
    }
    processes.get(owner.get(n.id)!)!.appendChild(e);
    nodeElements.set(n.id, e);
  }
  for (const edge of allEdges) {
    const e =
      nodes.get(edge.source)?.type === "router"
        ? (doc.importNode(donor("route"), true) as Element)
        : make(B, "bpmn2:sequenceFlow", {});
    e.setAttribute("id", edge.id);
    e.setAttribute("sourceRef", edge.source);
    e.setAttribute("targetRef", edge.target);
    e.removeAttribute("name");
    if (
      edge.name ||
      ["multicast", "sequentialMulticast"].includes(
        nodes.get(edge.source)!.type,
      )
    )
      e.setAttribute("name", edge.name || edge.id);
    if (nodes.get(edge.source)?.type === "router")
      property(e, "expressionType", edge.expressionType);
    if (edge.condition) {
      const c = make(
        B,
        "bpmn2:conditionExpression",
        { id: "Condition_" + edge.id },
        e,
      );
      c.setAttributeNS(
        "http://www.w3.org/2001/XMLSchema-instance",
        "xsi:type",
        "bpmn2:tFormalExpression",
      );
      c.textContent = edge.condition;
    }
    processes.get(owner.get(edge.source)!)!.appendChild(e);
  }
  const sender = elements(doc, B, "messageFlow")[0];
  sender.setAttribute("targetRef", starts[0].id);
  property(sender, "urlPath", bp.endpoint || "");
  property(sender, "xsrfProtection", bp.csrfProtected ? "1" : "0");
  if (bp.sender.type === "timer") {
    collaboration.removeChild(sender);
    const participant = elements(collaboration, B, "participant").find(
      (e) => e.getAttribute("id") === "Participant_1",
    );
    if (participant) collaboration.removeChild(participant);
  } else if (bp.sender.type === "sftp") {
    const channel = doc.importNode(donor("sftpSender"), true) as Element;
    channel.setAttribute("id", "MessageFlow_4");
    channel.setAttribute("sourceRef", "Participant_1");
    channel.setAttribute("targetRef", starts[0].id);
    for (const [key, value] of Object.entries({
      host: bp.sender.host,
      path: bp.sender.directory,
      fileName: bp.sender.fileName,
      credential_name: bp.sender.credentialName,
      system: "Sender",
      scheduleKey: bp.sender.scheduleKey,
      noop: bp.sender.postProcessing,
    }))
      property(channel, key, value);
    collaboration.replaceChild(channel, sender);
  }
  property(collaboration, "allowedHeaderList", bp.allowedHeaders.join("|"));
  const receiverEdges: { id: string; source: string; target: string }[] = [];
  for (const n of allNodes.filter((n) => n.receiver)) {
    const receiver = doc.importNode(
      donor("receiverParticipant"),
      true,
    ) as Element;
    receiver.setAttribute("id", "Receiver_" + n.id);
    receiver.setAttribute("name", n.receiver!.name);
    collaboration.appendChild(receiver);
    const channel = doc.importNode(
      donor(
        n.receiver!.type === "jms"
          ? "jmsReceiver"
          : n.receiver!.type === "sftp"
            ? "sftpReceiver"
            : n.receiver!.type === "odataV2"
              ? "odataV2Receiver"
              : "httpReceiver",
      ),
      true,
    ) as Element;
    const edge = {
      id: "Channel_" + n.id,
      source: n.id,
      target: "Receiver_" + n.id,
    };
    receiverEdges.push(edge);
    channel.setAttribute("id", edge.id);
    channel.setAttribute("sourceRef", edge.source);
    channel.setAttribute("targetRef", edge.target);
    const config = n.receiver!;
    channel.setAttribute("name", config.type || "HTTP");
    property(channel, "system", config.name);
    if (config.type === "jms")
      property(channel, "QueueName_outbound", config.queue);
    else if (config.type === "sftp") {
      for (const [key, value] of Object.entries({
        host: config.host,
        path: config.directory,
        fileName: config.fileName,
        credential_name: config.credentialName,
      }))
        property(channel, key, value);
    } else if (config.type === "odataV2") {
      for (const [key, value] of Object.entries({
        address: config.url,
        resourcePath: config.resourcePath,
        operation: config.operation,
        queryOptions: config.queryOptions,
        edmxFilePath: config.edmx.replace("src/main/resources/", ""),
        authenticationMethod: config.credentialName ? "Basic" : "None",
        alias: config.credentialName || "",
      }))
        property(channel, key, value);
    } else {
      const url = new URL(config.url);
      property(channel, "httpAddressWithoutQuery", url.origin + url.pathname);
      property(channel, "httpAddressQuery", url.search.slice(1));
      property(channel, "httpMethod", config.method);
      property(
        channel,
        "httpShouldSendBody",
        config.method === "GET" ? "false" : "true",
      );
    }
    collaboration.appendChild(channel);
  }
  const exceptionEdges: { id: string; source: string; target: string }[] = [];
  if (bp.exceptionHandler) {
    const sub = doc.importNode(donor("exception"), true) as Element;
    sub.setAttribute("id", "Exception_Subprocess");
    sub.setAttribute("name", "Exception Subprocess");
    for (const child of Array.from(sub.childNodes))
      if ((child as Element).localName !== "extensionElements")
        sub.removeChild(child);
    const errStart = doc.importNode(donor("errorStart"), true) as Element;
    const handler = doc.importNode(donor("groovy"), true) as Element;
    const errEnd = doc.importNode(donor("end"), true) as Element;
    for (const [e, id, name] of [
      [errStart, "Exception_Start", "Error Start"],
      [handler, "Exception_Handle", bp.exceptionHandler.name],
      [errEnd, "Exception_End", "Error Handled"],
    ] as const) {
      e.setAttribute("id", id);
      e.setAttribute("name", name);
      for (const c of Array.from(e.childNodes))
        if (["incoming", "outgoing"].includes((c as Element).localName || ""))
          e.removeChild(c);
      sub.appendChild(e);
    }
    property(handler, "scriptBundleId", "");
    property(handler, "script", bp.exceptionHandler.script);
    property(handler, "scriptFunction", "");
    exceptionEdges.push(
      {
        id: "Exception_F1",
        source: "Exception_Start",
        target: "Exception_Handle",
      },
      {
        id: "Exception_F2",
        source: "Exception_Handle",
        target: "Exception_End",
      },
    );
    for (const edge of exceptionEdges) {
      make(
        B,
        "bpmn2:sequenceFlow",
        { id: edge.id, sourceRef: edge.source, targetRef: edge.target },
        sub,
      );
      const source = elements(sub, B, "*").find(
        (e) => e.getAttribute("id") === edge.source,
      )!;
      const target = elements(sub, B, "*").find(
        (e) => e.getAttribute("id") === edge.target,
      )!;
      make(B, "bpmn2:outgoing", {}, source).textContent = edge.id;
      make(B, "bpmn2:incoming", {}, target).textContent = edge.id;
    }
    process.appendChild(sub);
  }
  const plane = elements(doc, D, "BPMNPlane")[0];
  while (plane.firstChild) plane.removeChild(plane.firstChild);
  const coords = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  for (const [i, n] of allNodes.entries())
    coords.set(n.id, {
      x: n.x ?? 200 + i * 150,
      y: n.y ?? 170 + graphs.findIndex((g) => g.id === owner.get(n.id)) * 420,
      w: ["start", "end"].includes(n.type)
        ? 32
        : ["router", "multicast", "sequentialMulticast", "join"].includes(
              n.type,
            )
          ? 40
          : 100,
      h: ["start", "end"].includes(n.type)
        ? 32
        : ["router", "multicast", "sequentialMulticast", "join"].includes(
              n.type,
            )
          ? 40
          : 60,
    });
  if (bp.exceptionHandler) {
    const y =
      Math.max(
        ...bp.nodes.map((n) => coords.get(n.id)!).map((c) => c.y + c.h),
      ) + 80;
    coords.set("Exception_Subprocess", { x: 200, y, w: 480, h: 150 });
    coords.set("Exception_Start", { x: 230, y: y + 60, w: 32, h: 32 });
    coords.set("Exception_Handle", { x: 340, y: y + 45, w: 100, h: 60 });
    coords.set("Exception_End", { x: 570, y: y + 60, w: 32, h: 32 });
  }
  for (const [index, g] of graphs.entries()) {
    const bounds = g.nodes.map((n) => coords.get(n.id)!);
    if (index === 0 && bp.exceptionHandler)
      bounds.push(coords.get("Exception_Subprocess")!);
    const x = Math.min(...bounds.map((c) => c.x)) - 60,
      y = Math.min(...bounds.map((c) => c.y)) - 80;
    coords.set(index === 0 ? "Participant_Process_1" : "Local_" + g.id, {
      x,
      y,
      w: Math.max(...bounds.map((c) => c.x + c.w)) - x + 100,
      h: Math.max(...bounds.map((c) => c.y + c.h)) - y + 80,
    });
  }
  if (bp.sender.type !== "timer")
    coords.set("Participant_1", { x: 30, y: 150, w: 80, h: 60 });
  for (const n of allNodes.filter((n) => n.receiver))
    coords.set("Receiver_" + n.id, {
      x: coords.get(n.id)!.x,
      y: 0,
      w: 100,
      h: 60,
    });
  for (const [id, c] of coords) {
    const shape = make(
      D,
      "bpmndi:BPMNShape",
      { id: "DI_" + id, bpmnElement: id },
      plane,
    );
    make(C, "dc:Bounds", { x: c.x, y: c.y, width: c.w, height: c.h }, shape);
  }
  for (const edge of [
    ...allEdges,
    ...receiverEdges,
    ...exceptionEdges,
    ...(bp.sender.type !== "timer"
      ? [{ id: "MessageFlow_4", source: "Participant_1", target: starts[0].id }]
      : []),
  ]) {
    const a = coords.get(edge.source)!,
      b = coords.get(edge.target)!;
    const shape = make(
      D,
      "bpmndi:BPMNEdge",
      {
        id: "DI_" + edge.id,
        bpmnElement: edge.id,
        sourceElement: "DI_" + edge.source,
        targetElement: "DI_" + edge.target,
      },
      plane,
    );
    make(I, "di:waypoint", { x: a.x + a.w, y: a.y + a.h / 2 }, shape);
    make(I, "di:waypoint", { x: b.x, y: b.y + b.h / 2 }, shape);
  }
  zip.deleteFile(modelPath);
  zip.addFile(
    `src/main/resources/scenarioflows/integrationflow/${bp.id}.iflw`,
    Buffer.from(new XMLSerializer().serializeToString(doc)),
  );
  const manifest = zip
    .readAsText("META-INF/MANIFEST.MF")
    .replaceAll("if_echo_mapping", bp.id)
    .replace(/Bundle-Version: [^\r\n]+/, "Bundle-Version: 1.0.0")
    .replace(
      /Bundle-Name: [^\r\n]+/,
      "Bundle-Name: " + bp.name.replace(/[\r\n]/g, ""),
    );
  zip.updateFile("META-INF/MANIFEST.MF", Buffer.from(foldManifest(manifest)));
  zip.updateFile(
    "metainfo.prop",
    Buffer.from("description=Generated by MCP blueprint compiler\n"),
  );
  for (const resource of bp.resources) {
    if (
      resource.path.includes("\\") ||
      resource.path.split("/").includes("..") ||
      /\.iflw$/.test(resource.path)
    )
      throw new Error("Unsafe resource path");
    zip.addFile(resource.path, Buffer.from(resource.content));
  }
  const buffer = zip.toBuffer();
  const validation = requireValidDesign(buffer);
  return {
    buffer,
    validation,
    nodes: allNodes.length,
    endpoint: bp.endpoint,
    idMap: Object.fromEntries(idMap),
  };
}
