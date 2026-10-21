import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import { compileBlueprint } from "../../api/iflow/blueprint";
import { validateDesignZip } from "../designValidation";
const {
  buildBlueprint,
} = require("../../../resources/scenarios/excel-po-dryrun/build-blueprint.cjs");
const B = "http://www.omg.org/spec/BPMN/20100524/MODEL";
describe("Excel PO dry-run deployment boundaries", () => {
  it("builds a ten-step flow with three scripts and native mapping/validation", () => {
    const bp = buildBlueprint(),
      compiled = compileBlueprint(bp);
    expect(bp.nodes).toHaveLength(10);
    expect(bp.nodes.filter((n: any) => n.type === "groovy")).toHaveLength(3);
    expect(
      bp.nodes.filter((n: any) => n.type === "contentModifier"),
    ).toHaveLength(2);
    expect(bp.nodes.filter((n: any) => n.type === "xmlValidator")).toHaveLength(
      2,
    );
    expect(bp.nodes.filter((n: any) => n.type === "xsltMapping")).toHaveLength(
      1,
    );
    expect(compiled.validation.valid).toBe(true);
    expect(compiled.validation.components).toBe(14);
    expect(compiled.validation.editorVerified).toBe(false);
  });
  it("rejects missing XSLT and XSD resources before uploading", () => {
    for (const extension of [
      ".xsl",
      "PurchaseOrders.xsd",
      "DryRunIdocBatch.xsd",
    ]) {
      const bp = buildBlueprint();
      bp.resources = bp.resources.filter(
        (r: any) => !r.path.endsWith(extension),
      );
      expect(() => compileBlueprint(bp)).toThrow(/requires a bundled/);
    }
  });
  it("rejects header-selected mappings and validators that suppress errors", () => {
    const bp = buildBlueprint();
    bp.nodes.find(
      (n: any) => n.type === "xsltMapping",
    ).properties.mappingSource = "mappingSrcHeader";
    expect(() => compileBlueprint(bp)).toThrow("Only bundled XSLT");
    delete bp.nodes.find((n: any) => n.type === "xsltMapping").properties
      .mappingSource;
    bp.nodes.find(
      (n: any) => n.type === "xmlValidator",
    ).properties.preventException = "true";
    expect(() => compileBlueprint(bp)).toThrow("must fail on invalid input");
  });
  it("detects removed mapping/schema resources in an existing ZIP", () => {
    for (const [file, code] of [
      ["mapping/MapCandidateIdocs.xsl", "MISSING_RESOURCE"],
      ["xsd/DryRunIdocBatch.xsd", "MISSING_XSD"],
    ]) {
      const zip = new AdmZip(compileBlueprint(buildBlueprint()).buffer);
      zip.deleteFile("src/main/resources/" + file);
      const result = validateDesignZip(zip.toBuffer());
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === code)).toBe(true);
    }
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
