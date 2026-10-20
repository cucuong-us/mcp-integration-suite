import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { compileBlueprint } from "../../api/iflow/blueprint";
import {
  updateDesignSafely,
  validateOnSAP,
  archivesEqual,
} from "../../api/iflow/safeDesign";
import AdmZip from "adm-zip";
jest.mock("@sap-cloud-sdk/http-client", () => ({
  executeHttpRequest: jest.fn(),
}));
jest.mock("../../api/api_destination", () => ({
  getCurrentDestination: async () => ({ url: "https://tenant.invalid/api/v1" }),
}));
const request = executeHttpRequest as jest.Mock;
function baseline() {
  return compileBlueprint({
    id: "Tx",
    name: "Transaction",
    endpoint: "/tx",
    nodes: [
      { id: "S", name: "Start", type: "start" },
      { id: "E", name: "End", type: "end" },
    ],
    edges: [{ id: "F", source: "S", target: "E" }],
  }).buffer;
}
describe("Artifact transaction safeguards", () => {
  beforeEach(() => request.mockReset());
  it("does not mistake changed ZIP timestamps for concurrent content changes", async () => {
    const original = baseline(),
      zip = new AdmZip(original);
    zip.getEntries()[0].header.time = new Date("2030-01-01T00:00:00Z");
    const repacked = zip.toBuffer();
    expect(archivesEqual(original, repacked)).toBe(true);
    request.mockImplementation(async (_dest, c) => {
      if (c.method === "GET") return { status: 200, data: repacked };
      if (c.method === "PUT") return { status: 200 };
      return {
        status: 202,
        headers: {},
        data: "Check execution result: Passed",
      };
    });
    await expect(
      updateDesignSafely("Tx", [
        { filepath: "src/main/resources/test.txt", content: "candidate" },
      ]),
    ).resolves.toMatchObject({ status: 200 });
  });
  it("rolls back the exact pre-update bytes after SAP validation fails", async () => {
    const original = baseline();
    let current = original;
    const writes: Buffer[] = [];
    request.mockImplementation(async (_dest, config) => {
      if (config.method === "GET") return { status: 200, data: current };
      if (config.method === "PUT") {
        current = Buffer.from(config.data.ArtifactContent, "base64");
        writes.push(current);
        return { status: 204 };
      }
      return {
        status: 202,
        headers: {},
        data: 'Check execution result: Failed [{"severity":"Error"}]',
      };
    });
    await expect(
      updateDesignSafely("Tx", [
        { filepath: "src/main/resources/test.txt", content: "candidate" },
      ]),
    ).rejects.toThrow("rolled back");
    expect(writes).toHaveLength(2);
    expect(current).toEqual(original);
  });
  it("retains a concurrent user edit instead of blindly rolling back", async () => {
    const original = baseline();
    let reads = 0,
      puts = 0;
    request.mockImplementation(async (_dest, c) => {
      if (c.method === "GET") {
        reads++;
        return {
          status: 200,
          data: reads < 3 ? original : Buffer.from("concurrent edit"),
        };
      }
      if (c.method === "PUT") {
        puts++;
        return { status: 204 };
      }
      return {
        status: 202,
        headers: {},
        data: "Check execution result: Failed",
      };
    });
    await expect(
      updateDesignSafely("Tx", [
        { filepath: "src/main/resources/test.txt", content: "candidate" },
      ]),
    ).rejects.toThrow();
    expect(puts).toBe(1);
  });
  it("refuses to treat arbitrary successful HTTP content as validation success", async () => {
    request.mockResolvedValue({
      status: 202,
      headers: {},
      data: "request accepted",
    });
    expect((await validateOnSAP("Tx")).status).toBe("unverified");
  });
  it("uses the explicit SAP validation outcome", async () => {
    request.mockResolvedValue({
      status: 202,
      headers: {},
      data: "Check execution result: Passed",
    });
    expect((await validateOnSAP("Tx")).status).toBe("passed");
  });
});
