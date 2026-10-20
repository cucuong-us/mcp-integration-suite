import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { getCurrentDestination } from "../api_destination";
import AdmZip from "adm-zip";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  requireValidDesign,
  validateDesignZip,
} from "../../utils/designValidation";

const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const artifactPath = (
  id: string,
  kind = "IntegrationDesigntimeArtifacts",
) =>
  `${kind}(Id='${encodeURIComponent(id.replace(/'/g, "''"))}',Version='active')`;
const locks = new Map<string, Promise<unknown>>();
export async function withArtifactLock<T>(
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(id) || Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  locks.set(id, result);
  try {
    return await result;
  } finally {
    if (locks.get(id) === result) locks.delete(id);
  }
}
export async function downloadDesign(
  id: string,
  kind?: string,
): Promise<Buffer> {
  const res = await executeHttpRequest(await getCurrentDestination(), {
    method: "GET",
    url: artifactPath(id, kind) + "/$value",
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(res.data);
}
export interface SapValidation {
  status: "passed" | "failed" | "unverified";
  httpStatus: number;
  details: unknown;
}
export async function validateOnSAP(id: string): Promise<SapValidation> {
  const res = await executeHttpRequest(await getCurrentDestination(), {
    method: "POST",
    url: `ValidateIntegrationDesigntimeArtifact?Id='${encodeURIComponent(id.replace(/'/g, "''"))}'&Version='active'`,
    headers: { Accept: "application/json" },
    validateStatus: () => true,
    timeout: 30000,
  });
  const header = res.headers?.checkexecutionresult;
  const raw =
    typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  const evidence =
    typeof header === "string" && /^(Passed|Failed)$/i.test(header.trim())
      ? header.trim()
      : /check\s*execution\s*result\s*:\s*(Passed|Failed)/i.exec(
          raw || "",
        )?.[1];
  const status =
    res.status >= 200 && res.status < 300
      ? evidence?.toLowerCase() === "failed"
        ? "failed"
        : evidence?.toLowerCase() === "passed"
          ? "passed"
          : "unverified"
      : "unverified";
  return {
    status,
    httpStatus: res.status,
    details: { checkexecutionresult: header, body: res.data },
  };
}
export interface DesignPatch {
  filepath: string;
  content: string;
  appendMode?: boolean;
}
export function patchArchive(original: Buffer, patches: DesignPatch[]): Buffer {
  if (!patches.length) throw new Error("At least one file patch is required");
  const zip = new AdmZip(original);
  const seen = new Set<string>();
  for (const p of patches) {
    const file = p.filepath;
    if (
      !file ||
      file.includes("\\") ||
      file.startsWith("/") ||
      /^[a-z]:/i.test(file) ||
      file.split("/").some((s) => !s || s === "." || s === "..")
    )
      throw new Error("Unsafe artifact-relative path: " + file);
    if (seen.has(file)) throw new Error("Duplicate patch path: " + file);
    seen.add(file);
    if (
      !file.startsWith("src/main/resources/") &&
      ![
        "META-INF/MANIFEST.MF",
        "metainfo.prop",
        "parameters.prop",
        "parameters.propdef",
        ".project",
      ].includes(file)
    )
      throw new Error("Unsupported artifact file path: " + file);
    const old = zip.getEntry(file);
    const data = Buffer.from(
      (p.appendMode && old ? zip.readAsText(old) : "") + p.content,
      "utf8",
    );
    if (old) zip.updateFile(file, data);
    else zip.addFile(file, data);
  }
  return zip.toBuffer();
}
async function putDesign(id: string, data: Buffer, kind?: string) {
  return executeHttpRequest(await getCurrentDestination(), {
    method: "PUT",
    url: artifactPath(id, kind),
    headers: { "Content-Type": "application/json" },
    data: { ArtifactContent: data.toString("base64") },
    timeout: 120000,
  });
}
/** Keeps a durable backup and never deploys. Rollback is guarded against concurrent edits. */
export async function updateDesignSafely(
  id: string,
  patches: DesignPatch[],
  kind = "IntegrationDesigntimeArtifacts",
) {
  return withArtifactLock(kind + ":" + id, async () => {
    const original = await downloadDesign(id, kind);
    const candidate = patchArchive(original, patches);
    const designValidation = requireValidDesign(
      candidate,
      kind === "IntegrationDesigntimeArtifacts" ? "iflow" : "mapping",
    );
    const backupRoot = path.resolve(__dirname, "../../../backups");
    await mkdir(backupRoot, { recursive: true });
    const backupPath = path.join(
      backupRoot,
      `${Date.now()}-${randomUUID()}.zip`,
    );
    await writeFile(backupPath, original, { flag: "wx", mode: 0o600 });
    const beforeUpload = await downloadDesign(id, kind);
    if (!archivesEqual(original, beforeUpload))
      throw new Error(
        "Concurrent edit detected; upload cancelled. Backup: " + backupPath,
      );
    let update;
    try {
      update = await putDesign(id, candidate, kind);
    } catch (e) {
      throw new Error(
        "Upload did not return success; outcome may be unverified. Inspect the artifact before retrying. Backup: " +
          backupPath +
          ". " +
          String(e),
      );
    }
    let sapValidation: SapValidation | undefined;
    if (kind === "IntegrationDesigntimeArtifacts") {
      try {
        sapValidation = await validateOnSAP(id);
        if (sapValidation.status !== "passed")
          throw new Error(
            "SAP design validation did not pass: " +
              JSON.stringify(sapValidation),
          );
      } catch (e) {
        // ZIP bytes may be normalized by SAP: compare per-entry content before rollback.
        const current = await downloadDesign(id, kind);
        let unchanged = false;
        try {
          unchanged = archivesEqual(current, candidate);
        } catch {
          /* A non-ZIP response cannot prove ownership of the current version. */
        }
        if (!unchanged)
          throw new Error(
            `Validation failed; another edit or SAP normalization prevents automatic rollback. Backup: ${backupPath}. ${String(e)}`,
          );
        await putDesign(id, original, kind);
        throw new Error(
          `Update rolled back. Backup: ${backupPath}. ${String(e)}`,
        );
      }
    }
    return {
      status: update.status,
      backupPath,
      designValidation,
      sapValidation,
      editorVerified: false as const,
    };
  });
}
export function archivesEqual(a: Buffer, b: Buffer): boolean {
  const stableContent = (name: string, buffer: Buffer): Buffer => {
    // SAP re-exports these Java properties files with a fresh #timestamp on every GET.
    // Preserve every value/continuation line; ignore comments and empty lines only.
    if (!["metainfo.prop", "src/main/resources/parameters.prop"].includes(name))
      return buffer;
    const lines: string[] = [];
    let continued = false;
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (!continued && (!line.trim() || /^\s*[#!]/.test(line))) continue;
      lines.push(line);
      continued = (/\\+$/.exec(line)?.[0].length || 0) % 2 === 1;
    }
    return Buffer.from(lines.join("\n"));
  };
  const entries = (buf: Buffer) =>
    new Map(
      new AdmZip(buf)
        .getEntries()
        .filter((e) => !e.isDirectory)
        .map((e) => [
          e.entryName,
          digest(stableContent(e.entryName, e.getData())),
        ]),
    );
  const aa = entries(a),
    bb = entries(b);
  return (
    aa.size === bb.size &&
    [...aa].every(([name, hash]) => bb.get(name) === hash)
  );
}
export async function inspectDesign(id: string) {
  const local = validateDesignZip(await downloadDesign(id));
  const sap = await validateOnSAP(id);
  return {
    local,
    sap,
    editorVerified: false,
    readyForDeployment: local.valid && sap.status === "passed",
  };
}
