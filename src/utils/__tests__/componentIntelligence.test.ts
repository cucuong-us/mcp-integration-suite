import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import { nodeSchema } from "../../api/iflow/blueprintSchema";
import { compileBlueprint } from "../../api/iflow/blueprint";
import {
  getComponentCatalog,
  analyzeBlueprint,
} from "../../api/iflow/componentIntelligence";
import { planIflow, PlanInput } from "../../api/iflow/planner";
export const sample =
  '<Batch><PurchaseOrder id="PO-A"><Item>1</Item><Item>2</Item></PurchaseOrder><PurchaseOrder id="PO-B"><Item>3</Item></PurchaseOrder></Batch>';
const spec = (): PlanInput => ({
  id: "SmartSplitTest",
  goal: "split-api",
  inputFormat: "xml",
  endpoint: "/smart/split",
  receiver: {
    url: "https://api.example.com/orders",
    method: "POST",
    authentication: { type: "basic", credentialName: "TestAlias" },
  },
  split: {
    xpath: "/Batch/PurchaseOrder",
    businessUnit: "purchaseOrder",
    recordElement: "PurchaseOrder",
    keyXPath: "@id",
    sampleXml: sample,
    response: {
      format: "json",
      requiredFields: ["documentId"],
      expectedFields: { status: "accepted" },
    },
  },
});
const plan = (input: PlanInput) => planIflow(input) as any;
const prop = (doc: any, id: string, key: string) =>
  Array.from(doc.getElementById(id).getElementsByTagName("ifl:property")).find(
    (p: any) => p.getElementsByTagName("key")[0].textContent === key,
  ) as any;
const getProp = (doc: any, id: string, key: string) =>
  prop(doc, id, key)?.getElementsByTagName("value")[0].textContent;
function model(bp: any) {
  const zip = new AdmZip(compileBlueprint(bp).buffer);
  return new DOMParser().parseFromString(
    zip.readAsText(
      zip.getEntries().find((e) => e.entryName.endsWith(".iflw"))!,
    ),
    "application/xml",
  );
}
describe("component planning and semantic analysis", () => {
  it("does not advertise plain-text concatenation as JSON fan-out aggregation", () => {
    const result = plan({
      id: "JsonFanout",
      goal: "parallel-enrichment",
      endpoint: "/fanout",
      outputFormat: "json",
      branches: [
        {
          name: "A",
          steps: [
            {
              id: "A",
              name: "A",
              type: "contentModifier",
              properties: { bodyType: "constant", wrapContent: '{"a":1}' },
            },
          ],
        },
        {
          name: "B",
          steps: [
            {
              id: "B",
              name: "B",
              type: "contentModifier",
              properties: { bodyType: "constant", wrapContent: '{"b":2}' },
            },
          ],
        },
      ],
    });
    expect(result.status).toBe("needs-input");
    expect(result.blueprint).toBeNull();
  });
  it("rejects a receiver that would silently be ignored by a transform plan", () => {
    expect(() =>
      plan({
        id: "Unused",
        goal: "transform",
        endpoint: "/unused",
        inputFormat: "xml",
        outputFormat: "json",
        receiver: { url: "https://api.example.com" },
      }),
    ).toThrow("not used");
  });
  it("preserves XML XPath conditions on generated Router edges", () => {
    const result = plan({
      id: "XmlRoute",
      goal: "route",
      endpoint: "/route",
      inputFormat: "xml",
      branches: [
        {
          name: "A",
          condition: "/Record/Kind = 'A'",
          expressionType: "XML",
          steps: [{ id: "A", name: "A", type: "contentModifier" }],
        },
        {
          name: "Default",
          default: true,
          steps: [{ id: "B", name: "B", type: "contentModifier" }],
        },
      ],
    });
    expect(
      result.blueprint.edges.find((e: any) => e.condition).expressionType,
    ).toBe("XML");
    expect(compileBlueprint(result.blueprint).validation.valid).toBe(true);
  });
  it("places worker error handling in the local process with Error End", () => {
    const doc = model(plan(spec()).blueprint);
    const local = doc.getElementById("Process_Local_RecordWorker")!;
    const sub = doc.getElementById(
      "SubProcess_Exception_Process_Local_RecordWorker",
    )!;
    expect(sub.parentNode).toBe(local);
    expect(
      doc
        .getElementById("EndEvent_Exception_Process_Local_RecordWorker")!
        .getElementsByTagNameNS(
          "http://www.omg.org/spec/BPMN/20100524/MODEL",
          "errorEventDefinition",
        ).length,
    ).toBe(1);
  });
  it("rejects a worker that swallows errors in a fail-fast split", () => {
    const bp = plan(spec()).blueprint;
    bp.localProcesses[0].exceptionHandler.end = "message";
    expect(() => compileBlueprint(bp)).toThrow("SPLITTER_ERROR_SWALLOWED");
  });
  it("uses SAP-valid dormant threads and lowercase XPath table types", () => {
    const doc = model(plan(spec()).blueprint);
    expect(getProp(doc, "CallActivity_Split", "ParallelProcessing")).toBe(
      "false",
    );
    expect(getProp(doc, "CallActivity_Split", "SplitterThreads")).toBe("2");
    expect(
      getProp(doc, "CallActivity_Local_WorkerHeaders", "headerTable"),
    ).toContain("<cell id='Type'>xpath</cell>");
  });
  it("requires enough timeout budget for parallel API waits", () => {
    const p = spec();
    p.split!.parallel = true;
    p.split!.concurrency = 2;
    p.split!.receiverEnforcesIdempotency = true;
    expect(() => plan(p)).toThrow("timeout budget");
  });
  it("rejects path traversal business keys", () => {
    const p = spec();
    p.split!.sampleXml = sample.replace("PO-A", "..");
    expect(() => plan(p)).toThrow("business keys");
  });
  it("supports explicit DELETE bodies and validated record keys in URL paths", () => {
    const p = spec();
    p.receiver = {
      url: "https://api.example.com/orders",
      method: "DELETE",
      sendBody: true,
      appendRecordKeyToPath: true,
    };
    const doc = model(plan(p).blueprint),
      id = "Channel_ServiceTask_Local_WorkerCall";
    expect(getProp(doc, id, "httpShouldSendBody")).toBe("true");
    expect(getProp(doc, id, "httpAddressWithoutQuery")).toBe(
      "https://api.example.com/orders/${header.X-Smart-Key}",
    );
  });
  it("has a decision guide for every supported node type", () => {
    expect(Object.keys(getComponentCatalog().components).sort()).toEqual(
      [...nodeSchema.shape.type.options].sort(),
    );
  });
  it("asks for missing contracts instead of inventing an API or XPath", () => {
    const result = plan({ id: "Incomplete", goal: "split-api" });
    expect(result.status).toBe("needs-input");
    expect(result.blueprint).toBeNull();
    expect(result.requiredInputs.length).toBeGreaterThan(2);
  });
  it("splits complete POs rather than the three item rows", () => {
    const result = plan(spec());
    expect(result.readyForPreview).toBe(true);
    expect(result.analysis.samples.CallActivity_Split).toEqual({
      records: 2,
      groups: 2,
    });
    expect(
      result.blueprint.nodes.find((n: any) => n.type === "generalSplitter")
        .splitter.grouping,
    ).toBe(1);
    expect(
      result.blueprint.localProcesses[0].nodes.some(
        (n: any) => n.type === "requestReply",
      ),
    ).toBe(true);
    expect(compileBlueprint(result.blueprint).validation.valid).toBe(true);
  });
  it("does not embed sample payload in generated production scripts", () => {
    const p = spec();
    p.split!.sampleXml = sample.replace(
      "<Item>1</Item>",
      "<Item>SENSITIVE_SAMPLE_ONLY</Item>",
    );
    const bp = plan(p).blueprint;
    for (const r of bp.resources) {
      expect(r.content).not.toContain("SENSITIVE_SAMPLE_ONLY");
      if (r.content.includes("decodeBase64")) {
        const token = /'([A-Za-z0-9+/=]+)'\.decodeBase64/.exec(r.content);
        if (token)
          expect(Buffer.from(token[1], "base64").toString()).not.toContain(
            "SENSITIVE_SAMPLE_ONLY",
          );
      }
    }
  });
  it.each(["/Batch/Missing", "/Batch/PurchaseOrder/Item"])(
    "rejects an invalid business boundary %s",
    (expression) => {
      const p = spec();
      p.split!.xpath = expression;
      expect(() => plan(p)).toThrow();
    },
  );
  it("rejects duplicate or missing business keys", () => {
    const p = spec();
    p.split!.sampleXml = sample.replace("PO-B", "PO-A");
    expect(() => plan(p)).toThrow("business keys");
    p.split!.sampleXml = sample.replace('id="PO-B"', "");
    expect(() => plan(p)).toThrow("business keys");
  });
  it("refuses declaring item rows as purchase-order operations", () => {
    const p = spec();
    p.split!.xpath = "/Batch/PurchaseOrder/Item";
    p.split!.recordElement = "Item";
    expect(() => plan(p)).toThrow("complete POs");
  });
  it("requires real business response assertions", () => {
    const p = spec();
    p.split!.response = { format: "json" };
    expect(() => plan(p)).toThrow("business assertions");
  });
  it("guards parallel writes and sets explicit execution policy", () => {
    const p = spec();
    p.split!.parallel = true;
    p.split!.concurrency = 2;
    expect(() => plan(p)).toThrow("receiver-enforced");
    p.split!.receiverEnforcesIdempotency = true;
    p.split!.maxRecords = 2;
    const bp = plan(p).blueprint,
      doc = model(bp);
    expect(getProp(doc, "CallActivity_Split", "ParallelProcessing")).toBe(
      "true",
    );
    expect(
      getProp(
        doc,
        "Channel_ServiceTask_Local_WorkerCall",
        "allowedRequestHeaders",
      ),
    ).toContain("Idempotency-Key");
  });
  it("sets HTTP auth, PATCH, timeout, headers and safe defaults in exported metadata", () => {
    const p = spec();
    p.receiver = {
      url: "https://api.example.com/orders?q=x",
      method: "PATCH",
      authentication: {
        type: "oauth2ClientCredentials",
        credentialName: "OAuthAlias",
      },
      timeoutMs: 1234,
      requestHeaders: ["X-Company"],
    };
    const doc = model(plan(p).blueprint),
      id = "Channel_ServiceTask_Local_WorkerCall";
    expect(getProp(doc, id, "authenticationMethod")).toBe(
      "OAuth2 Client Credentials",
    );
    expect(getProp(doc, id, "credentialName")).toBe("OAuthAlias");
    expect(getProp(doc, id, "httpRequestTimeout")).toBe("1234");
    expect(getProp(doc, id, "httpMethod")).toBe("PATCH");
    expect(getProp(doc, id, "retryOnConnectionFailure")).toBe("false");
    expect(getProp(doc, id, "enableMPLAttachments")).toBe("false");
  });
  it.each(["Authorization", "CamelHttpUri", "*"])(
    "rejects unsafe outbound header forwarding %s",
    (header) => {
      const p = spec();
      p.receiver = { url: "https://api.example.com", requestHeaders: [header] };
      expect(() => plan(p)).toThrow();
    },
  );
  it("detects an HTTP error policy that has no status router", () => {
    const p = spec();
    const bp = plan(p).blueprint;
    bp.localProcesses[0].nodes.find(
      (n: any) => n.type === "requestReply",
    ).receiver.errorHandling = "route";
    expect(
      analyzeBlueprint(bp).issues.some(
        (i) => i.code === "UNHANDLED_HTTP_STATUS",
      ),
    ).toBe(true);
    expect(() => compileBlueprint(bp)).toThrow("UNHANDLED_HTTP_STATUS");
  });
  it("rejects swallowed split errors", () => {
    const bp = plan(spec()).blueprint;
    bp.exceptionHandler.end = "message";
    expect(() => compileBlueprint(bp)).toThrow("SPLITTER_ERROR_SWALLOWED");
  });
  it("analyzes namespaced samples and emits SAP namespace mappings", () => {
    const p = spec();
    p.namespaces = { p: "urn:test:purchase-orders" };
    p.split!.sampleXml =
      '<p:Batch xmlns:p="urn:test:purchase-orders"><p:PurchaseOrder id="A"/></p:Batch>';
    p.split!.xpath = "/p:Batch/p:PurchaseOrder";
    const result = plan(p);
    expect(result.analysis.samples.CallActivity_Split.records).toBe(1);
    expect(
      getProp(model(result.blueprint), "Collaboration_1", "namespaceMapping"),
    ).toBe("xmlns:p=urn:test:purchase-orders");
  });
  it("rejects sample DTDs and malformed XML without issuing requests", () => {
    const p = spec();
    p.split!.sampleXml =
      '<!DOCTYPE Batch [<!ENTITY x SYSTEM "file:///private">]><Batch/>';
    expect(() => plan(p)).toThrow("DTD");
  });
  it.each([
    "transform",
    "validate",
    "route",
    "parallel-enrichment",
    "ordered-fanout",
    "deliver",
    "reuse",
  ] as const)("builds a concrete %s recipe", (goal) => {
    const request: PlanInput = {
      id: "Recipe_" + goal.replace(/-/g, "_"),
      endpoint: "/recipe",
      inputFormat: "xml",
      goal,
    };
    if (goal === "transform") request.outputFormat = "json";
    if (goal === "validate") {
      request.steps = [
        {
          id: "Validator",
          name: "Validate",
          type: "xmlValidator",
          properties: { xsd: "/xsd/Record.xsd" },
        },
      ];
      request.resources = [
        {
          path: "src/main/resources/xsd/Record.xsd",
          content:
            '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="Record" type="xs:string"/></xs:schema>',
        },
      ];
    }
    if (goal === "deliver")
      request.receiver = { type: "jms", queue: "TestQueue" };
    if (goal === "reuse")
      request.steps = [
        {
          id: "Set",
          name: "Set",
          type: "contentModifier",
          properties: { bodyType: "constant", wrapContent: "<Result/>" },
        },
      ];
    if (["route", "parallel-enrichment", "ordered-fanout"].includes(goal)) {
      request.outputFormat = "xml";
      request.branches = [
        {
          name: "A",
          condition: "${property.kind} = 'a'",
          steps: [
            {
              id: "A",
              name: "A",
              type: "contentModifier",
              properties: { bodyType: "constant", wrapContent: "<Result/>" },
            },
          ],
        },
        {
          name: "B",
          default: true,
          steps: [
            {
              id: "B",
              name: "B",
              type: "contentModifier",
              properties: { bodyType: "constant", wrapContent: "<Result/>" },
            },
          ],
        },
      ];
    }
    const result = plan(request);
    expect(result.readyForPreview).toBe(true);
    expect(compileBlueprint(result.blueprint).validation.valid).toBe(true);
  });
});
