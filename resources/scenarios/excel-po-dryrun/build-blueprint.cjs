const fs = require("node:fs"),
  path = require("node:path");
const dir = __dirname;
const stages = [
  "ReadPurchaseOrderXlsx",
  "ValidatePurchaseOrders",
  "AuditDryRun",
];
const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
function propertyTable(values) {
  return Object.entries(values)
    .map(
      ([Name, Value]) =>
        "<row>" +
        Object.entries({
          Action: "Create",
          Type: "constant",
          Value,
          Default: "",
          Name,
          Datatype: "java.lang.String",
        })
          .map(
            ([key, value]) =>
              "<cell id='" + key + "'>" + escapeXml(value) + "</cell>",
          )
          .join("") +
        "</row>",
    )
    .join("");
}
function buildBlueprint({
  id = "McpExcelPoDryRun20261021",
  caseName = "valid",
  bytes,
  masterData,
} = {}) {
  bytes =
    bytes || fs.readFileSync(path.join(dir, "fixtures/purchase-orders.xlsx"));
  masterData =
    masterData ||
    fs.readFileSync(path.join(dir, "fixtures/master-data.json"), "utf8");
  if (!/^[A-Za-z0-9_.-]+$/.test(caseName))
    throw Error("Invalid dry-run case name");
  const nodes = [
    {
      id: "StartEvent_DryRun",
      name: "Timer - synthetic Excel fixture",
      type: "start",
    },
    {
      id: "CallActivity_LoadFixture",
      name: "Content Modifier - test fixture only",
      type: "contentModifier",
      properties: {
        bodyType: "constant",
        wrapContent: bytes.toString("base64"),
        propertyTable: propertyTable({
          dryRun: "true",
          dryRunCase: caseName,
          fixtureEncoding: "base64",
          fixtureMasterData: masterData,
        }),
      },
    },
    {
      id: "CallActivity_ReadPurchaseOrderXlsx",
      name: "Read bounded XLSX",
      type: "groovy",
      properties: { script: "ReadPurchaseOrderXlsx.groovy" },
    },
    {
      id: "CallActivity_ValidatePurchaseOrders",
      name: "Validate business rules and fixture master data",
      type: "groovy",
      properties: { script: "ValidatePurchaseOrders.groovy" },
    },
    {
      id: "CallActivity_ValidateCanonical",
      name: "XML Validator - canonical PO contract",
      type: "xmlValidator",
      properties: { xsd: "/xsd/PurchaseOrders.xsd" },
    },
    {
      id: "CallActivity_MapCandidate",
      name: "XSLT Mapping - candidate IDocs",
      type: "xsltMapping",
      properties: {
        mappinguri:
          "dir://mapping/xslt/src/main/resources/mapping/MapCandidateIdocs.xsl",
        mappingname: "MapCandidateIdocs",
        mappingpath: "src/main/resources/mapping/MapCandidateIdocs",
      },
    },
    {
      id: "CallActivity_ValidateCandidate",
      name: "XML Validator - local candidate contract only",
      type: "xmlValidator",
      properties: { xsd: "/xsd/DryRunIdocBatch.xsd" },
    },
    {
      id: "CallActivity_DryRunStatus",
      name: "Content Modifier - NOT POSTED",
      type: "contentModifier",
      properties: {
        bodyType: "expression",
        wrapContent: "${in.body}",
        propertyTable: propertyTable({
          deliveryStatus: "NOT_POSTED",
          externalCalls: "0",
          backendPoCreated: "false",
          idocSchemaVerified: "false",
        }),
      },
    },
    {
      id: "CallActivity_AuditDryRun",
      name: "Audit mapping integrity and record MPL metadata",
      type: "groovy",
      properties: { script: "AuditDryRun.groovy" },
    },
    {
      id: "EndEvent_DryRun",
      name: "Dry-run finished - no SAP posting",
      type: "end",
    },
  ];
  return {
    id,
    name: "Excel PO IDoc Dry Run - " + caseName,
    sender: { type: "timer", runOnce: true },
    nodes,
    edges: nodes
      .slice(1)
      .map((node, i) => ({
        id: "SequenceFlow_DryRun_" + i,
        source: nodes[i].id,
        target: node.id,
      })),
    resources: [
      ...[...stages, "RecordDryRunFailure"].map((stage) => ({
        path: "src/main/resources/script/" + stage + ".groovy",
        content: fs.readFileSync(
          path.join(dir, "scripts", stage + ".groovy"),
          "utf8",
        ),
      })),
      ...[
        "mapping/MapCandidateIdocs.xsl",
        "xsd/PurchaseOrders.xsd",
        "xsd/DryRunIdocBatch.xsd",
      ].map((file) => ({
        path: "src/main/resources/" + file,
        content: fs.readFileSync(path.join(dir, file), "utf8"),
      })),
    ],
    exceptionHandler: {
      script: "RecordDryRunFailure.groovy",
      name: "Record failure without logging payload",
      end: "error",
    },
  };
}
module.exports = { buildBlueprint, stages };
if (require.main === module)
  fs.writeFileSync(
    process.argv[2] || path.join(dir, "blueprint.json"),
    JSON.stringify(buildBlueprint(), null, 2) + "\n",
  );
