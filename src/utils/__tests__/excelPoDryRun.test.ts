import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import { compileBlueprint } from "../../api/iflow/blueprint";
const {
  buildBlueprint,
} = require("../../../resources/scenarios/excel-po-dryrun/build-blueprint.cjs");
const B = "http://www.omg.org/spec/BPMN/20100524/MODEL";
describe("Excel PO dry-run deployment boundaries", () => {
  it("builds a ten-step flow with scripts and an exception subprocess", () => {
    const bp = buildBlueprint(),
      compiled = compileBlueprint(bp);
    expect(bp.nodes).toHaveLength(10);
    expect(compiled.validation.valid).toBe(true);
    expect(compiled.validation.components).toBe(14);
    expect(compiled.validation.editorVerified).toBe(false);
  });
  it("contains no receiver channels, SFTP polling or HTTP sender endpoint", () => {
    const bp = buildBlueprint(),
      zip = new AdmZip(compileBlueprint(bp).buffer);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".iflw"))!;
    const doc = new DOMParser().parseFromString(
      zip.readAsText(entry),
      "application/xml",
    );
    expect(doc.getElementsByTagNameNS(B, "messageFlow").length).toBe(0);
    expect(doc.getElementsByTagNameNS(B, "participant").length).toBe(1);
    expect(doc.getElementsByTagNameNS(B, "timerEventDefinition").length).toBe(
      1,
    );
    const errorEnd = doc.getElementById("EndEvent_Exception")!;
    expect(
      errorEnd.getElementsByTagNameNS(B, "errorEventDefinition").length,
    ).toBe(1);
    expect(doc.getElementById("SubProcess_Exception")).not.toBeNull();
    expect(bp.endpoint).toBeUndefined();
  });
  it("requires safe fixture labels before embedding executable script literals", () => {
    expect(() => buildBlueprint({ caseName: "bad' injection" })).toThrow(
      "Invalid dry-run case",
    );
  });
});
