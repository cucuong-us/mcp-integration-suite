import { readFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import { Blueprint, compileBlueprint } from "../../api/iflow/blueprint";
import { elements, validateDesignZip } from "../designValidation";
const B = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const load = (name: string): Blueprint =>
  JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        "../../../resources/blueprints/" + name + ".json",
      ),
      "utf8",
    ),
  );
const xml = (bp: Blueprint) => {
  const zip = new AdmZip(compileBlueprint(bp).buffer);
  return new DOMParser().parseFromString(
    zip.readAsText(
      zip.getEntries().find((e) => e.entryName.endsWith(".iflw"))!,
    ),
    "application/xml",
  );
};
const prop = (doc: any, id: string, key: string) =>
  elements(doc.getElementById(id), "*", "property")
    .find((p) => p.getElementsByTagName("key")[0]?.textContent === key)
    ?.getElementsByTagName("value")[0]?.textContent;

describe("Extended blueprint graph and adapters", () => {
  it("emits real separate local process scopes and resolves Process Call IDs", () => {
    const doc = xml(load("McpLocalProcessConverterLab"));
    expect(prop(doc, "CallLocal", "processId")).toBe(
      "Process_Local_ConvertProcess",
    );
    expect(doc.getElementById("CallActivity_Local_Convert")?.parentNode).toBe(
      doc.getElementById("Process_Local_ConvertProcess"),
    );
    expect(doc.getElementById("CallLocal")?.parentNode).toBe(
      doc.getElementById("Process_1"),
    );
    expect(
      doc
        .getElementById("Local_Process_Local_ConvertProcess")
        ?.getAttribute("processRef"),
    ).toBe("Process_Local_ConvertProcess");
    expect(elements(doc, B, "process")).toHaveLength(2);
  });
  it("rejects missing or recursive local process references", () => {
    const bp = load("McpLocalProcessConverterLab");
    bp.nodes.find((n) => n.type === "processCall")!.processId = "Missing";
    expect(() => compileBlueprint(bp)).toThrow("Unknown local process");
    bp.nodes.find((n) => n.type === "processCall")!.processId =
      "ConvertProcess";
    Object.assign(bp.localProcesses![0].nodes[1], {
      type: "processCall",
      processId: "ConvertProcess",
    });
    expect(() => compileBlueprint(bp)).toThrow("Recursive");
  });
  it("rejects edges crossing local process scopes and globally duplicated IDs", () => {
    const bp = load("McpLocalProcessConverterLab");
    bp.edges[0].target = "LocalStart";
    expect(() => compileBlueprint(bp)).toThrow("unknown node");
    const dup = load("McpLocalProcessConverterLab");
    dup.localProcesses![0].nodes[0].id = "Start";
    expect(() => compileBlueprint(dup)).toThrow("unique");
  });
  it("generates sequential route order with fresh edge IDs", () => {
    const doc = xml(load("McpSequentialMulticastLab"));
    expect(prop(doc, "FanOut", "routingSequenceTable")).toBe(
      "<row><cell>1</cell><cell>F1</cell></row><row><cell>2</cell><cell>F2</cell></row>",
    );
    expect(doc.getElementById("Join")?.localName).toBe("parallelGateway");
    expect(doc.getElementById("F1")?.getAttribute("name")).toBe("F1");
    expect(doc.getElementById("F2")?.getAttribute("name")).toBe("F2");
  });
  it.each(["McpParallelMulticastLab", "McpSequentialMulticastLab"])(
    "rejects a branch bypassing its Join in %s",
    (name) => {
      const bp = load(name);
      bp.edges.find((e) => e.source === "BranchB")!.target = "End";
      expect(() => compileBlueprint(bp)).toThrow("Join");
    },
  );
  it("rejects branches merging before the Join", () => {
    const bp = load("McpParallelMulticastLab");
    bp.edges.find((e) => e.source === "BranchB")!.target = "BranchA";
    expect(() => compileBlueprint(bp)).toThrow("before their Join");
  });
  it("rejects dangling Join and unpaired Gather", () => {
    const bp = load("McpSplitterGatherLab");
    bp.nodes[1] = { id: "Split", name: "Join", type: "join" };
    expect(() => compileBlueprint(bp)).toThrow("Join");
    bp.nodes[1] = { id: "Split", name: "Modifier", type: "contentModifier" };
    expect(() => compileBlueprint(bp)).toThrow("Gather requires");
  });
  it("rejects a splitter without an expression", () => {
    const bp = load("McpSplitterGatherLab");
    bp.nodes[1].properties = {};
    expect(() => compileBlueprint(bp)).toThrow("splitExprValue");
  });
  it("generates timer definition without HTTPS sender channel or participant", () => {
    const doc = xml(load("McpTimerRunOnceLab"));
    expect(elements(doc, B, "timerEventDefinition")).toHaveLength(1);
    expect(elements(doc, B, "messageFlow")).toHaveLength(0);
    expect(doc.getElementById("Participant_1")).toBeNull();
    expect(prop(doc, "Timer_Start", "scheduleKey")).toContain("fireNow=true");
  });
  it("prevents mixing a timer sender with an HTTP endpoint", () => {
    const bp = load("McpTimerRunOnceLab");
    bp.endpoint = "/invalid";
    expect(() => compileBlueprint(bp)).toThrow("endpoint");
  });
  it("preserves an exported timer schedule and rejects ambiguous or malformed schedules", () => {
    const bp = load("McpTimerRunOnceLab");
    const table =
      "<row><cell>triggerType</cell><cell>cron</cell></row><row><cell>schedule1</cell><cell>0+0+0+?+*+*+*</cell></row>";
    bp.sender = { type: "timer", scheduleKey: table };
    expect(prop(xml(bp), "Timer_Start", "scheduleKey")).toBe(table);
    bp.sender = { type: "timer", runOnce: true, scheduleKey: table };
    expect(() => compileBlueprint(bp)).toThrow("exactly one");
    bp.sender = { type: "timer", scheduleKey: "<broken>" };
    expect(() => compileBlueprint(bp)).toThrow("scheduler");
  });
  it("requires explicit delete post-processing for SFTP sender and emits its scheduler", () => {
    const bp = load("McpSftpSenderLab"),
      doc = xml(bp);
    expect(prop(doc, "MessageFlow_4", "noop")).toBe("delete");
    expect(prop(doc, "MessageFlow_4", "host")).toBe("sftp.example.com:22");
    expect(prop(doc, "MessageFlow_4", "scheduleKey")).toContain("fireNow=true");
    delete (bp.sender as any).postProcessing;
    expect(() => compileBlueprint(bp)).toThrow();
  });
  it("detects lost Multicast branch names in arbitrary artifact updates", () => {
    const zip = new AdmZip(
      compileBlueprint(load("McpParallelMulticastLab")).buffer,
    );
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".iflw"))!;
    zip.updateFile(
      entry,
      Buffer.from(zip.readAsText(entry).replace('name="F1"', 'name=""')),
    );
    expect(
      validateDesignZip(zip.toBuffer()).errors.some(
        (e) => e.code === "MULTICAST_BRANCH_NAME",
      ),
    ).toBe(true);
  });
  it("uses Send for JMS/SFTP and rejects Request Reply with those adapters", () => {
    for (const name of ["McpJmsReceiverLab", "McpSftpReceiverLab"]) {
      const bp = load(name),
        id = bp.nodes[1].id,
        doc = xml(bp);
      expect(prop(doc, id, "activityType")).toBe("Send");
      bp.nodes[1].type = "requestReply";
      expect(() => compileBlueprint(bp)).toThrow("require send");
    }
  });
  it("sets adapter destinations and credential aliases without inheriting sample endpoints", () => {
    const jms = xml(load("McpJmsReceiverLab")),
      sftp = xml(load("McpSftpReceiverLab"));
    expect(prop(jms, "Channel_Publish", "QueueName_outbound")).toBe(
      "McpComponentLabQueue",
    );
    expect(prop(sftp, "Channel_WriteFile", "host")).toBe("sftp.example.com:22");
    expect(prop(sftp, "Channel_WriteFile", "credential_name")).toBe(
      "McpSftpCredential",
    );
    expect(sftp.toString()).not.toMatch(/jnj\.com|MBOX_USER|GTSUS/);
  });
  it("requires bundled OData metadata and catches removal during artifact updates", () => {
    const bp = load("McpODataV2ReceiverLab");
    expect(prop(xml(bp), "Channel_ReadProducts", "receiveTimeOut")).toBe("60");
    const zip = new AdmZip(compileBlueprint(bp).buffer);
    zip.deleteFile("src/main/resources/edmx/sample.edmx");
    expect(
      validateDesignZip(zip.toBuffer()).errors.some(
        (e) => e.code === "MISSING_EDMX",
      ),
    ).toBe(true);
    bp.resources = [];
    expect(() => compileBlueprint(bp)).toThrow("metadata resource");
  });
  it("validates EDMX XML and Process Call references after arbitrary ZIP updates", () => {
    const bp = load("McpODataV2ReceiverLab");
    bp.resources![0].content = "<broken>";
    expect(() => compileBlueprint(bp)).toThrow("INVALID_XML");
    const zip = new AdmZip(
      compileBlueprint(load("McpLocalProcessConverterLab")).buffer,
    );
    const e = zip.getEntries().find((e) => e.entryName.endsWith(".iflw"))!;
    zip.updateFile(
      e,
      Buffer.from(
        zip
          .readAsText(e)
          .replace(
            "<value>Process_Local_ConvertProcess</value>",
            "<value>Missing</value>",
          ),
      ),
    );
    expect(
      validateDesignZip(zip.toBuffer()).errors.some(
        (e) => e.code === "MISSING_LOCAL_PROCESS",
      ),
    ).toBe(true);
  });
  it("rejects global graph overflow and raw sequence cycles", () => {
    const bp = load("McpLocalProcessConverterLab");
    bp.localProcesses = Array.from({ length: 20 }, (_, i) => {
      const nodes = Array.from({ length: 6 }, (_, j) => ({
        id: "N" + i + "_" + j,
        name: "Node",
        type: (j === 0 ? "start" : j === 5 ? "end" : "contentModifier") as
          "start" | "end" | "contentModifier",
      }));
      return {
        id: "P" + i,
        name: "P" + i,
        nodes,
        edges: nodes.slice(1).map((n, j) => ({
          id: "E" + i + "_" + j,
          source: nodes[j].id,
          target: n.id,
        })),
      };
    });
    expect(() => compileBlueprint(bp)).toThrow("Global graph limits");
    const cycle = load("McpSplitterGatherLab");
    cycle.edges.push({ id: "Cycle", source: "Gather", target: "Split" });
    expect(() => compileBlueprint(cycle)).toThrow("cycle");
  });
});
