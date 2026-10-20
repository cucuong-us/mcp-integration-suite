import { DOMParser, XMLSerializer, Element } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { globSync } from "glob";
import { z } from "zod";
import { elements, requireValidDesign } from "../../utils/designValidation";
const B = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const D = "http://www.omg.org/spec/BPMN/20100524/DI";
const C = "http://www.omg.org/spec/DD/20100524/DC";
const I = "http://www.omg.org/spec/DD/20100524/DI";
const F = "http:///com.sap.ifl.model/Ifl.xsd";
const root = path.resolve(__dirname, "../../../resources");
const safeId = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(120);
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
export const blueprintSchema = z
  .object({
    id: safeId,
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_. -]*$/,
        "SAP artifact name permits ASCII letters, numbers, underscore, spaces, period and hyphen only",
      )
      .refine(
        (n) => !n.endsWith(".") && n === n.trim(),
        "Name cannot end with a period or whitespace",
      ),
    endpoint: z.string().regex(/^\/[A-Za-z0-9_./-]+$/),
    csrfProtected: z.boolean().default(true),
    allowedHeaders: z
      .array(z.string().regex(/^[A-Za-z0-9_-]+$/))
      .default(["SAP_ApplicationID"]),
    nodes: z
      .array(
        z
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
              "requestReply",
            ]),
            receiver: z
              .object({
                url: z.string().url(),
                method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
                name: z
                  .string()
                  .regex(
                    /^[A-Za-z_][A-Za-z0-9_.-]*$/,
                    "SAP receiver name cannot contain spaces",
                  )
                  .default("HTTPReceiver"),
              })
              .strict()
              .optional(),
            properties: z.record(z.string()).default({}),
            x: z.number().finite().nonnegative().optional(),
            y: z.number().finite().nonnegative().optional(),
          })
          .strict(),
      )
      .min(2)
      .max(100),
    edges: z
      .array(
        z
          .object({
            id: safeId,
            source: safeId,
            target: safeId,
            condition: z.string().optional(),
            default: z.boolean().default(false),
            expressionType: z.enum(["XML", "NonXML"]).default("NonXML"),
          })
          .strict(),
      )
      .min(1)
      .max(200),
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
    exceptionHandler: z
      .object({
        script: z.string().regex(/^[A-Za-z0-9_.-]+\.groovy$/),
        name: z.string().default("Handle Exception"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Blueprint = z.input<typeof blueprintSchema>;
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
  errorStart: [
    "examples/iflows/if_google_ads_campaigns/**/*.iflw",
    "StartEvent_457",
  ],
};
function donor(type: string): Element {
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
  const nodes = new Map(bp.nodes.map((n) => [n.id, n]));
  const ids = [...bp.nodes.map((n) => n.id), ...bp.edges.map((e) => e.id)];
  if (new Set(ids).size !== ids.length)
    throw new Error("Node/edge IDs must be unique");
  if (
    ids.some(
      (id) =>
        [
          "Definitions_1",
          "Collaboration_1",
          "Participant_1",
          "Participant_Process_1",
          "Process_1",
          "MessageFlow_4",
          "BPMNDiagram_1",
          "BPMNPlane_1",
        ].includes(id) ||
        /^(DI_|Exception_|Receiver_|Channel_|Condition_)/.test(id),
    )
  )
    throw new Error("Reserved diagram ID");
  const starts = bp.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1 || !bp.nodes.some((n) => n.type === "end"))
    throw new Error("One start and at least one end are required");
  for (const e of bp.edges)
    if (!nodes.has(e.source) || !nodes.has(e.target))
      throw new Error("Edge references unknown node: " + e.id);
  for (const n of bp.nodes) {
    if ((n.type === "requestReply") !== !!n.receiver)
      throw new Error(
        "Receiver configuration is required only for requestReply: " + n.id,
      );
    if (n.receiver) {
      const url = new URL(n.receiver.url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Receiver requires HTTPS and no embedded credentials");
    }
    const outgoing = bp.edges.filter((e) => e.source === n.id),
      incoming = bp.edges.filter((e) => e.target === n.id);
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
    } else if (n.type !== "end" && outgoing.length !== 1)
      throw new Error("Use router for branching: " + n.id);
    if (outgoing.some((e) => e.default || e.condition) && n.type !== "router")
      throw new Error("Conditions/default only supported on router edges");
  }
  const reachable = (startIds: string[], reverse: boolean) => {
    const visited = new Set(startIds),
      queue = [...startIds];
    while (queue.length) {
      const current = queue.shift();
      for (const e of bp.edges)
        if ((reverse ? e.target : e.source) === current) {
          const target = reverse ? e.source : e.target;
          if (!visited.has(target)) {
            visited.add(target);
            queue.push(target);
          }
        }
    }
    return visited;
  };
  if (
    reachable([starts[0].id], false).size !== bp.nodes.length ||
    reachable(
      bp.nodes.filter((n) => n.type === "end").map((n) => n.id),
      true,
    ).size !== bp.nodes.length
  )
    throw new Error("All nodes must be reachable and have a path to an end");
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
  const nodeElements = new Map<string, Element>();
  for (const n of bp.nodes) {
    const e = doc.importNode(donor(n.type), true) as Element;
    e.setAttribute("id", n.id);
    e.setAttribute("name", n.name);
    e.removeAttribute("default");
    for (const child of Array.from(e.childNodes))
      if (["incoming", "outgoing"].includes((child as Element).localName || ""))
        e.removeChild(child);
    if (n.type === "groovy") property(e, "scriptBundleId", "");
    for (const [key, value] of Object.entries(n.properties)) {
      if (
        [
          "cmdVariantUri",
          "componentVersion",
          "activityType",
          "subActivityType",
        ].includes(key)
      )
        throw new Error("Component identity cannot be overridden: " + key);
      property(e, key, value);
    }
    for (const edge of bp.edges) {
      if (edge.target === n.id)
        make(B, "bpmn2:incoming", {}, e).textContent = edge.id;
      if (edge.source === n.id)
        make(B, "bpmn2:outgoing", {}, e).textContent = edge.id;
      if (edge.source === n.id && edge.default)
        e.setAttribute("default", edge.id);
    }
    process.appendChild(e);
    nodeElements.set(n.id, e);
  }
  for (const edge of bp.edges) {
    const e =
      nodes.get(edge.source)?.type === "router"
        ? (doc.importNode(donor("route"), true) as Element)
        : make(B, "bpmn2:sequenceFlow", {});
    e.setAttribute("id", edge.id);
    e.setAttribute("sourceRef", edge.source);
    e.setAttribute("targetRef", edge.target);
    e.removeAttribute("name");
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
    process.appendChild(e);
  }
  const sender = elements(doc, B, "messageFlow")[0];
  sender.setAttribute("targetRef", starts[0].id);
  property(sender, "urlPath", bp.endpoint);
  property(sender, "xsrfProtection", bp.csrfProtected ? "1" : "0");
  const collaboration = elements(doc, B, "collaboration")[0];
  property(collaboration, "allowedHeaderList", bp.allowedHeaders.join("|"));
  const receiverEdges: { id: string; source: string; target: string }[] = [];
  for (const n of bp.nodes.filter((n) => n.receiver)) {
    const receiver = doc.importNode(
      donor("receiverParticipant"),
      true,
    ) as Element;
    receiver.setAttribute("id", "Receiver_" + n.id);
    receiver.setAttribute("name", n.receiver!.name);
    collaboration.appendChild(receiver);
    const channel = doc.importNode(donor("httpReceiver"), true) as Element;
    const edge = {
      id: "Channel_" + n.id,
      source: n.id,
      target: "Receiver_" + n.id,
    };
    receiverEdges.push(edge);
    channel.setAttribute("id", edge.id);
    channel.setAttribute("sourceRef", edge.source);
    channel.setAttribute("targetRef", edge.target);
    const url = new URL(n.receiver!.url);
    property(channel, "httpAddressWithoutQuery", url.origin + url.pathname);
    property(channel, "httpAddressQuery", url.search.slice(1));
    property(channel, "httpMethod", n.receiver!.method);
    property(channel, "system", n.receiver!.name);
    property(
      channel,
      "httpShouldSendBody",
      n.receiver!.method === "GET" ? "false" : "true",
    );
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
  for (const [i, n] of bp.nodes.entries())
    coords.set(n.id, {
      x: n.x ?? 200 + i * 150,
      y: n.y ?? 170,
      w: ["start", "end"].includes(n.type)
        ? 32
        : n.type === "router"
          ? 40
          : 100,
      h: ["start", "end"].includes(n.type) ? 32 : n.type === "router" ? 40 : 60,
    });
  if (bp.exceptionHandler) {
    const y = Math.max(...[...coords.values()].map((c) => c.y + c.h)) + 80;
    coords.set("Exception_Subprocess", { x: 200, y, w: 480, h: 150 });
    coords.set("Exception_Start", { x: 230, y: y + 60, w: 32, h: 32 });
    coords.set("Exception_Handle", { x: 340, y: y + 45, w: 100, h: 60 });
    coords.set("Exception_End", { x: 570, y: y + 60, w: 32, h: 32 });
  }
  const width = Math.max(...[...coords.values()].map((c) => c.x + c.w)) + 100;
  coords.set("Participant_Process_1", {
    x: 140,
    y: 90,
    w: width - 140,
    h: Math.max(...[...coords.values()].map((c) => c.y + c.h)) + 80,
  });
  coords.set("Participant_1", { x: 30, y: 150, w: 80, h: 60 });
  for (const n of bp.nodes.filter((n) => n.receiver))
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
    ...bp.edges,
    ...receiverEdges,
    ...exceptionEdges,
    { id: "MessageFlow_4", source: "Participant_1", target: starts[0].id },
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
  return { buffer, validation, nodes: bp.nodes.length, endpoint: bp.endpoint };
}
