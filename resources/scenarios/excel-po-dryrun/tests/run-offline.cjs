const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../../../.."),
  scenario = path.resolve(__dirname, "..");
const work = path.join(repo, "work/po-dryrun"),
  jar = path.join(work, "tools/groovy-all-2.4.21.jar");
const sha = "de65260cf2070442e99882f2f3d72e7531725c1e6a257446cc0cea525c607bd0";
function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: repo,
    stdio: "inherit",
    shell: false,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error(command + " failed with exit " + r.status);
}
(async () => {
  if (
    spawnSync("java", ["-version"], { stdio: "ignore", shell: false })
      .status !== 0
  )
    throw Error("Java 8+ must be installed and available on PATH");
  fs.mkdirSync(path.dirname(jar), { recursive: true });
  if (!fs.existsSync(jar)) {
    const r = await fetch(
      "https://repo.maven.apache.org/maven2/org/codehaus/groovy/groovy-all/2.4.21/groovy-all-2.4.21.jar",
    );
    if (!r.ok) throw Error("Groovy download HTTP " + r.status);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== sha)
      throw Error("Groovy checksum mismatch");
    fs.writeFileSync(jar, bytes);
  }
  if (
    crypto.createHash("sha256").update(fs.readFileSync(jar)).digest("hex") !==
    sha
  )
    throw Error("Cached Groovy checksum mismatch");
  run(process.execPath, [
    path.join(__dirname, "generate-cases.cjs"),
    path.join(work, "cases"),
  ]);
  const { buildBlueprint } = require("../build-blueprint.cjs");
  fs.writeFileSync(
    path.join(work, "execution-blueprint.json"),
    JSON.stringify(buildBlueprint()),
  );
  run("java", [
    "-cp",
    jar,
    "groovy.ui.GroovyMain",
    path.join(__dirname, "run.groovy"),
    scenario,
    path.join(work, "cases"),
    path.join(work, "offline-results"),
    path.join(work, "execution-blueprint.json"),
  ]);
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
