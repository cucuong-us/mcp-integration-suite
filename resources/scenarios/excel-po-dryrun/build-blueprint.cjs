const fs = require("node:fs"),
  path = require("node:path");
const dir = __dirname;
const stages = [
  "ReadPurchaseOrderXlsx",
  "ValidatePurchaseOrders",
  "ValidateFixtureMasterData",
  "MapCandidateIdocs",
  "CheckCandidateContract",
  "SimulateDelivery",
  "RecordDryRunEvidence",
];
function buildBlueprint({
  id = "McpExcelPoDryRun20261020",
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
  const loader = `import com.sap.gateway.ip.core.customdev.util.Message
import java.security.MessageDigest
Message processData(Message message) {
 byte[] bytes='${bytes.toString("base64")}'.decodeBase64()
 message.setBody(bytes)
 message.setProperty('dryRun',true)
 message.setProperty('dryRunCase','${caseName}')
 message.setProperty('sourceSha256',MessageDigest.getInstance('SHA-256').digest(bytes).encodeHex().toString())
 message.setProperty('fixtureMasterData',new String('${Buffer.from(masterData).toString("base64")}'.decodeBase64(),'UTF-8'))
 return message
}
`;
  const nodes = [
    {
      id: "StartEvent_DryRun",
      name: "Timer - synthetic Excel fixture",
      type: "start",
    },
    {
      id: "CallActivity_LoadFixture",
      name: "Load Excel fixture and dry-run context",
      type: "groovy",
      properties: { script: "LoadDryRunFixture.groovy" },
    },
    ...stages.map((stage) => ({
      id: "CallActivity_" + stage,
      name: stage.replace(/([a-z])([A-Z])/g, "$1 $2"),
      type: "groovy",
      properties: { script: stage + ".groovy" },
    })),
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
      {
        path: "src/main/resources/script/LoadDryRunFixture.groovy",
        content: loader,
      },
      ...[...stages, "RecordDryRunFailure"].map((stage) => ({
        path: "src/main/resources/script/" + stage + ".groovy",
        content: fs.readFileSync(
          path.join(dir, "scripts", stage + ".groovy"),
          "utf8",
        ),
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
if (require.main === module) {
  const output = process.argv[2] || path.join(dir, "blueprint.json");
  fs.writeFileSync(output, JSON.stringify(buildBlueprint(), null, 2) + "\n");
  console.log("Written " + output);
}
