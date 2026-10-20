// Explicit live verification, separate from npm test. Sends synthetic payloads once per case.
const fs = require("node:fs"),
  path = require("node:path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
  quiet: true,
});
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
async function main() {
  if (!process.argv.includes("--live"))
    throw new Error(
      "Use --live to send the synthetic test cases to your configured tenant.",
    );
  if (
    ![
      "CPI_OAUTH_CLIENT_ID",
      "CPI_OAUTH_CLIENT_SECRET",
      "CPI_OAUTH_TOKEN_URL",
    ].every((k) => process.env[k])
  )
    throw new Error(
      "Configure CPI_OAUTH_* with an integration-flow service key before running the runtime matrix.",
    );
  const root = path.resolve(__dirname, "../..");
  const tests = JSON.parse(
    fs.readFileSync(
      path.join(root, "resources/testcases/runtime-matrix.json"),
      "utf8",
    ),
  );
  const client = new Client({ name: "cpi-runtime-matrix", version: "1.0.0" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/index.js")],
      stderr: "pipe",
    });
  transport.stderr?.on("data", () => {});
  const results = [];
  const folder = path.join(root, "artifacts");
  fs.mkdirSync(folder, { recursive: true });
  try {
    await client.connect(transport);
    for (const test of tests) {
      const r = await client.callTool(
        { name: "test-iflow", arguments: { testCase: test.testCase } },
        undefined,
        { timeout: 180000 },
      );
      let data;
      try {
        data = JSON.parse(r.content.find((c) => c.type === "text").text);
      } catch {
        data = r;
      }
      results.push({
        name: test.name,
        id: test.testCase.id,
        isError: !!r.isError,
        result: data,
      });
      fs.writeFileSync(
        path.join(folder, "runtime-report.json"),
        JSON.stringify(
          { createdAt: new Date().toISOString(), results },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          name: test.name,
          outcome: data.outcome || "error",
          isError: !!r.isError,
        }),
      );
      if (
        /runtime authentication|CPI_OAUTH|client credentials/i.test(
          JSON.stringify(data),
        )
      )
        break;
    }
  } finally {
    await client.close();
  }
  if (
    results.length !== tests.length ||
    results.some((r) => r.result.outcome !== "passed")
  )
    process.exitCode = 2;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
