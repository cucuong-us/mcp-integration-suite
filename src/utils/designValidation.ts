import AdmZip from "adm-zip";
import { DOMParser, Element } from "@xmldom/xmldom";

const BPMN = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const DI = "http://www.omg.org/spec/BPMN/20100524/DI";
export interface DesignIssue {
  code: string;
  file: string;
  element?: string;
  message: string;
}
export interface DesignReport {
  valid: boolean;
  errors: DesignIssue[];
  warnings: DesignIssue[];
  files: number;
  components: number;
  editorVerified: false;
}
export const elements = (e: any, ns: string, name: string): Element[] =>
  Array.from(e.getElementsByTagNameNS(ns, name)) as Element[];

/** Structural checks, deliberately separate from SAP semantic/editor validation. */
export function validateDesignZip(
  buffer: Buffer,
  kind: "iflow" | "mapping" = "iflow",
): DesignReport {
  const report: DesignReport = {
    valid: false,
    errors: [],
    warnings: [],
    files: 0,
    components: 0,
    editorVerified: false,
  };
  const error = (
    code: string,
    file: string,
    message: string,
    element?: string,
  ) => report.errors.push({ code, file, element, message });
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch {
    error("INVALID_ZIP", "", "Artifact must be a valid ZIP bundle");
    return report;
  }
  const files = new Map<string, Buffer>();
  let expanded = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      name.split("/").includes("..")
    ) {
      error("UNSAFE_PATH", name, "Unsafe archive path");
      continue;
    }
    if (entry.isDirectory) continue;
    if (files.has(name))
      error("DUPLICATE_FILE", name, "Duplicate archive entry");
    expanded += entry.header.size;
    if (
      expanded > 64 * 1024 * 1024 ||
      entry.header.size > 16 * 1024 * 1024 ||
      files.size >= 1000
    ) {
      error(
        "BUNDLE_LIMIT",
        name,
        "Bundle exceeds validation limits (64 MiB total, 16 MiB/file, 1000 files)",
      );
      return report;
    }
    try {
      files.set(name, entry.getData());
    } catch {
      error("CORRUPT_ENTRY", name, "Cannot decompress entry");
    }
  }
  report.files = files.size;
  if (!files.has("META-INF/MANIFEST.MF"))
    error(
      "MISSING_MANIFEST",
      "META-INF/MANIFEST.MF",
      "Manifest must be at ZIP root",
    );
  const models = [...files.keys()].filter((n) =>
    /^src\/main\/resources\/scenarioflows\/integrationflow\/[^/]+\.iflw$/.test(
      n,
    ),
  );
  if (kind === "iflow" && models.length !== 1)
    error(
      "IFLOW_MODEL_COUNT",
      "",
      "Expected exactly one .iflw under src/main/resources/scenarioflows/integrationflow",
    );
  if (
    kind === "mapping" &&
    ![...files.keys()].some((n) =>
      /^src\/main\/resources\/mapping\/[^/]+\.mmap$/.test(n),
    )
  )
    error("MISSING_MAPPING", "", "Expected a message mapping resource");
  for (const [file, content] of files) {
    if (!/\.(iflw|xml|xsd|mmap|xsl|xslt|edmx)$/i.test(file)) continue;
    const text = content.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
      error("XML_DTD", file, "DTD/entity declarations are not supported");
      continue;
    }
    const parseErrors: string[] = [];
    let doc;
    try {
      doc = new DOMParser({
        onError: (level, message) => {
          parseErrors.push(message);
        },
      }).parseFromString(text, "application/xml");
    } catch (e) {
      parseErrors.push(String(e));
    }
    if (!doc?.documentElement || parseErrors.length) {
      error("INVALID_XML", file, parseErrors.join("; "));
      continue;
    }
    if (!file.endsWith(".iflw")) continue;
    if (
      doc.documentElement.namespaceURI !== BPMN ||
      doc.documentElement.localName !== "definitions"
    ) {
      error("BPMN_ROOT", file, "Expected BPMN definitions root");
      continue;
    }
    const all = elements(doc, "*", "*");
    const ids = new Map<string, Element>();
    for (const node of all) {
      const id = node.getAttribute("id");
      if (!id) continue;
      if (ids.has(id)) error("DUPLICATE_ID", file, "ID must be unique", id);
      ids.set(id, node);
    }
    const refs = [
      "sourceRef",
      "targetRef",
      "processRef",
      "bpmnElement",
      "default",
      "attachedToRef",
    ];
    for (const node of all) {
      for (const attr of refs) {
        const value = node.getAttribute(attr);
        if (value && !ids.has(value))
          error(
            "MISSING_REFERENCE",
            file,
            `${attr} references missing ${value}`,
            node.getAttribute("id") || undefined,
          );
      }
      if (
        node.namespaceURI === BPMN &&
        ["incoming", "outgoing"].includes(node.localName || "")
      ) {
        const flow = ids.get((node.textContent || "").trim());
        const parent = node.parentNode as Element;
        const attr = node.localName === "incoming" ? "targetRef" : "sourceRef";
        if (
          !flow ||
          flow.localName !== "sequenceFlow" ||
          flow.getAttribute(attr) !== parent.getAttribute("id")
        )
          error(
            "FLOW_REFERENCE",
            file,
            `${node.localName} does not match a sequenceFlow endpoint`,
            parent.getAttribute("id") || undefined,
          );
      }
    }
    const shapes = new Set(
      elements(doc, DI, "BPMNShape").map((n) => n.getAttribute("bpmnElement")),
    );
    const edges = new Set(
      elements(doc, DI, "BPMNEdge").map((n) => n.getAttribute("bpmnElement")),
    );
    const nodeTypes = [
      "participant",
      "startEvent",
      "endEvent",
      "callActivity",
      "serviceTask",
      "exclusiveGateway",
      "parallelGateway",
      "subProcess",
      "intermediateCatchEvent",
      "intermediateThrowEvent",
    ];
    for (const node of elements(doc, BPMN, "*")) {
      const id = node.getAttribute("id") || "";
      const directExt = Array.from(node.childNodes).find(
        (n) => (n as Element).localName === "extensionElements",
      );
      const props = new Map<string, string>();
      if (directExt)
        for (const p of elements(
          directExt,
          "http:///com.sap.ifl.model/Ifl.xsd",
          "property",
        )) {
          props.set(
            p.getElementsByTagName("key")[0]?.textContent || "",
            p.getElementsByTagName("value")[0]?.textContent || "",
          );
        }
      if (
        [
          "collaboration",
          "process",
          "callActivity",
          "serviceTask",
          "exclusiveGateway",
          "parallelGateway",
          "messageFlow",
        ].includes(node.localName || "") &&
        !props.get("cmdVariantUri")
      )
        error(
          "MISSING_COMPONENT_METADATA",
          file,
          "SAP component cmdVariantUri is required",
          id,
        );
      if (
        props.get("script") &&
        !props.get("scriptBundleId") &&
        !files.has("src/main/resources/script/" + props.get("script"))
      )
        error(
          "MISSING_SCRIPT",
          file,
          "Local script not found: " + props.get("script"),
          id,
        );
      if (
        props.get("processId") &&
        ids.get(props.get("processId")!)?.localName !== "process"
      )
        error(
          "MISSING_LOCAL_PROCESS",
          file,
          "Process Call references a missing process",
          id,
        );
      if (
        props.get("edmxFilePath") &&
        !files.has("src/main/resources/" + props.get("edmxFilePath"))
      )
        error(
          "MISSING_EDMX",
          file,
          "OData metadata resource does not exist",
          id,
        );
      if (
        ["Multicast", "SequentialMulticast"].includes(
          props.get("activityType") || "",
        )
      ) {
        for (const flow of elements(doc, BPMN, "sequenceFlow").filter(
          (f) => f.getAttribute("sourceRef") === id,
        ))
          if (!flow.getAttribute("name")?.trim())
            error(
              "MULTICAST_BRANCH_NAME",
              file,
              "Multicast branches must have names",
              flow.getAttribute("id") || undefined,
            );
      }
      if (node.localName === "exclusiveGateway") {
        const outgoing = elements(doc, BPMN, "sequenceFlow").filter(
          (f) => f.getAttribute("sourceRef") === id,
        );
        const defaultId = node.getAttribute("default");
        if (
          outgoing.length > 1 &&
          (!defaultId ||
            !outgoing.some((e) => e.getAttribute("id") === defaultId))
        )
          error(
            "ROUTER_DEFAULT",
            file,
            "Branching router needs a valid default route",
            id,
          );
      }
      if (nodeTypes.includes(node.localName || "")) {
        if (!shapes.has(id))
          error("MISSING_DI_SHAPE", file, "Missing diagram shape", id);
        if (node.localName !== "participant") report.components++;
      }
      if (
        ["sequenceFlow", "messageFlow"].includes(node.localName || "") &&
        !edges.has(id)
      )
        error("MISSING_DI_EDGE", file, "Missing diagram edge", id);
    }
    if (!elements(doc, DI, "BPMNPlane").length)
      error("MISSING_DIAGRAM", file, "Missing BPMNPlane");
    for (const shape of elements(doc, DI, "BPMNShape")) {
      const bounds = elements(
        shape,
        "http://www.omg.org/spec/DD/20100524/DC",
        "Bounds",
      )[0];
      if (
        !bounds ||
        ["x", "y", "width", "height"].some(
          (k) =>
            !bounds.hasAttribute(k) ||
            !Number.isFinite(Number(bounds.getAttribute(k))),
        ) ||
        Number(bounds?.getAttribute("width")) <= 0 ||
        Number(bounds?.getAttribute("height")) <= 0
      )
        error(
          "INVALID_BOUNDS",
          file,
          "Shape requires finite coordinates and positive dimensions",
          shape.getAttribute("id") || undefined,
        );
    }
    for (const edge of elements(doc, DI, "BPMNEdge")) {
      const points = elements(
        edge,
        "http://www.omg.org/spec/DD/20100524/DI",
        "waypoint",
      );
      if (
        points.length < 2 ||
        points.some((p) =>
          ["x", "y"].some(
            (k) =>
              !p.hasAttribute(k) || !Number.isFinite(Number(p.getAttribute(k))),
          ),
        )
      )
        error(
          "INVALID_WAYPOINTS",
          file,
          "Edge requires at least two waypoints",
          edge.getAttribute("id") || undefined,
        );
    }
    for (const node of all) {
      if (node.localName !== "value") continue;
      const value = (node.textContent || "").trim();
      const match = /^dir:\/\/[^/]+\/(src\/main\/resources\/[^?#]+)$/.exec(
        value,
      );
      if (match && !files.has(match[1]))
        error("MISSING_RESOURCE", file, `Resource does not exist: ${match[1]}`);
    }
  }
  report.warnings.push({
    code: "SAP_VALIDATION_REQUIRED",
    file: "",
    message:
      "Structural validation cannot certify SAP component semantics, mapping correctness or editor compatibility. Run SAP validation and open in SAP editor.",
  });
  report.valid = report.errors.length === 0;
  return report;
}

export function requireValidDesign(
  buffer: Buffer,
  kind: "iflow" | "mapping" = "iflow",
): DesignReport {
  const report = validateDesignZip(buffer, kind);
  if (!report.valid)
    throw new Error("Design validation failed: " + JSON.stringify(report));
  return report;
}
