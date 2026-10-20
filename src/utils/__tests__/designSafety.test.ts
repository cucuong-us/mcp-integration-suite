import { compileBlueprint, Blueprint } from "../../api/iflow/blueprint";
import { validateDesignZip } from "../designValidation";
import { patchArchive, archivesEqual } from "../../api/iflow/safeDesign";
import AdmZip from "adm-zip";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
jest.mock("../../api/api_destination", () => ({
  getCurrentDestination: jest.fn(),
}));

export const simple = (): Blueprint => ({
  id: "McpSafetyTest",
  name: "MCP Safety Test",
  endpoint: "/mcp/safety",
  nodes: [
    { id: "Start", name: "Start", type: "start" },
    {
      id: "Prepare",
      name: "Prepare",
      type: "contentModifier",
      properties: { bodyType: "constant", wrapContent: "<ok/>" },
    },
    { id: "End", name: "End", type: "end" },
  ],
  edges: [
    { id: "F1", source: "Start", target: "Prepare" },
    { id: "F2", source: "Prepare", target: "End" },
  ],
});
function changeModel(buf: Buffer, transform: (xml: string) => string) {
  const zip = new AdmZip(buf),
    entry = zip.getEntries().find((e) => e.entryName.endsWith(".iflw"))!;
  zip.updateFile(entry, Buffer.from(transform(zip.readAsText(entry))));
  return zip.toBuffer();
}
describe("Design safety boundaries", () => {
  it("compiles all shipped scenarios, including HTTP receivers and exception subprocesses", () => {
    const folder = path.resolve(__dirname, "../../../resources/blueprints");
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".json"))) {
      const compiled = compileBlueprint(
        JSON.parse(readFileSync(path.join(folder, file), "utf8")),
      );
      expect(compiled.validation.errors).toEqual([]);
      const mf = new AdmZip(compiled.buffer).readAsText("META-INF/MANIFEST.MF");
      expect(
        mf.split("\r\n").every((line) => Buffer.byteLength(line, "utf8") <= 72),
      ).toBe(true);
    }
  });
  it("generates a structurally coherent ZIP and diagram", () => {
    const a = compileBlueprint(simple());
    expect(a.validation.valid).toBe(true);
    expect(a.validation.components).toBe(3);
    expect(a.validation.editorVerified).toBe(false);
  });
  it("rejects missing references and duplicate IDs", () => {
    const buf = compileBlueprint(simple()).buffer;
    const report = validateDesignZip(
      changeModel(buf, (s) =>
        s
          .replace('targetRef="Prepare"', 'targetRef="Missing"')
          .replace('id="Prepare"', 'id="Start"'),
      ),
    );
    expect(report.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["DUPLICATE_ID", "MISSING_REFERENCE"]),
    );
  });
  it("rejects missing diagram metadata even if semantic XML is present", () => {
    const buf = compileBlueprint(simple()).buffer;
    expect(
      validateDesignZip(
        changeModel(buf, (s) =>
          s.replace(
            /<bpmndi:BPMNShape[^>]*bpmnElement="Prepare"[\s\S]*?<\/bpmndi:BPMNShape>/,
            "",
          ),
        ),
      ).errors.some((e) => e.code === "MISSING_DI_SHAPE"),
    ).toBe(true);
  });
  it("rejects malformed XML before upload", () => {
    const buf = compileBlueprint(simple()).buffer;
    expect(
      validateDesignZip(changeModel(buf, (s) => s.slice(0, -20))).valid,
    ).toBe(false);
  });
  it("rejects broken mapping resource references", () => {
    const buf = compileBlueprint(simple()).buffer;
    const report = validateDesignZip(
      changeModel(buf, (s) =>
        s.replace(
          "<value>&lt;ok/&gt;</value>",
          "<value>dir://mmap/src/main/resources/mapping/absent.mmap</value>",
        ),
      ),
    );
    expect(report.errors.some((e) => e.code === "MISSING_RESOURCE")).toBe(true);
  });
  it("rejects scripts stored in the wrong plural directory", () => {
    const bp = simple();
    bp.nodes[1].type = "groovy";
    bp.nodes[1].properties = { script: "a.groovy" };
    bp.resources = [
      { path: "src/main/resources/scripts/a.groovy", content: "script" },
    ];
    expect(() => compileBlueprint(bp)).toThrow("MISSING_SCRIPT");
  });
  it("rejects disconnected nodes and incomplete routing", () => {
    const bp = simple();
    bp.nodes.push({ id: "Unused", name: "Unused", type: "contentModifier" });
    expect(() => compileBlueprint(bp)).toThrow("connections");
    const route = simple();
    route.nodes[1].type = "router";
    expect(() => compileBlueprint(route)).toThrow("Router");
  });
  it("rejects names that SAP rejected in live validation before any upload", () => {
    const bp = simple();
    bp.name = "Invalid & Name";
    expect(() => compileBlueprint(bp)).toThrow();
    const http = simple();
    http.nodes[1].type = "requestReply";
    http.nodes[1].receiver = {
      url: "https://example.com",
      name: "Receiver With Spaces",
    };
    expect(() => compileBlueprint(http)).toThrow();
  });
  it("rejects unsupported blueprint settings instead of silently dropping user intent", () => {
    expect(() =>
      compileBlueprint({ ...simple(), sender: { type: "Timer" } } as any),
    ).toThrow();
  });
  it("appends without overwriting and preserves untouched binary resources", () => {
    const zip = new AdmZip(compileBlueprint(simple()).buffer);
    zip.addFile("src/main/resources/script/a.groovy", Buffer.from("first"));
    zip.addFile("src/main/resources/x.bin", Buffer.from([0, 255, 1]));
    const updated = new AdmZip(
      patchArchive(zip.toBuffer(), [
        {
          filepath: "src/main/resources/script/a.groovy",
          content: " second",
          appendMode: true,
        },
      ]),
    );
    expect(updated.readAsText("src/main/resources/script/a.groovy")).toBe(
      "first second",
    );
    expect(updated.readFile("src/main/resources/x.bin")).toEqual(
      Buffer.from([0, 255, 1]),
    );
  });
  it("blocks traversal and ambiguous patches", () => {
    const buf = compileBlueprint(simple()).buffer;
    expect(() =>
      patchArchive(buf, [{ filepath: "../outside", content: "x" }]),
    ).toThrow("Unsafe");
    expect(() =>
      patchArchive(buf, [
        { filepath: "src/main/resources/a", content: "x" },
        { filepath: "src/main/resources/a", content: "y" },
      ]),
    ).toThrow("Duplicate");
  });
  it("detects content changes independently of ZIP metadata", () => {
    const a = compileBlueprint(simple()).buffer;
    const b = new AdmZip(a).toBuffer();
    expect(archivesEqual(a, b)).toBe(true);
    expect(
      archivesEqual(
        a,
        patchArchive(a, [
          { filepath: "src/main/resources/a.txt", content: "changed" },
        ]),
      ),
    ).toBe(false);
  });
  it("ignores SAP-generated property timestamps but preserves parameter changes", () => {
    const a = new AdmZip(compileBlueprint(simple()).buffer),
      b = new AdmZip(a.toBuffer());
    a.updateFile(
      "src/main/resources/parameters.prop",
      Buffer.from("#Monday\nendpoint=/orders\n"),
    );
    b.updateFile(
      "src/main/resources/parameters.prop",
      Buffer.from("#Tuesday\nendpoint=/orders\n"),
    );
    expect(archivesEqual(a.toBuffer(), b.toBuffer())).toBe(true);
    b.updateFile(
      "src/main/resources/parameters.prop",
      Buffer.from("#Tuesday\nendpoint=/other\n"),
    );
    expect(archivesEqual(a.toBuffer(), b.toBuffer())).toBe(false);
  });
});
