import { testIflow } from "../../api/iflow/testIflow";
import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { sendRequestToCPI } from "../../api/messages/sendMessageToCPI";
jest.mock("@sap-cloud-sdk/http-client", () => ({
  executeHttpRequest: jest.fn(),
}));
jest.mock("../../api/api_destination", () => ({
  getCurrentDestination: async () => ({}),
}));
jest.mock("../../api/iflow/index", () => ({
  getEndpoints: async () => [
    {
      protocol: "REST",
      entryPoints: [{ url: "https://tenant-rt.invalid/http/test" }],
    },
  ],
}));
jest.mock("../../api/messages/sendMessageToCPI", () => ({
  sendRequestToCPI: jest.fn(),
}));
const request = executeHttpRequest as jest.Mock,
  send = sendRequestToCPI as jest.Mock;
describe("End-to-end test verdicts", () => {
  beforeEach(() => {
    request.mockReset();
    send.mockReset();
    send.mockResolvedValue({
      status: 200,
      response: '{"status":"ok"}',
      messageGuid: "test-guid",
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const setup = (logs: any[]) =>
    request
      .mockResolvedValueOnce({ data: { d: { Status: "STARTED" } } })
      .mockResolvedValue({ data: { d: { results: logs } } });
  it("requires HTTP assertions plus a uniquely correlated completed MPL for PASS", async () => {
    setup([
      {
        MessageGuid: "test-guid",
        Status: "COMPLETED",
        IntegrationArtifact: { Id: "Flow" },
      },
    ]);
    const report = await testIflow({
      id: "Flow",
      body: "{}",
      expectedJson: { status: "ok" },
    });
    expect(report.outcome).toBe("passed");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("never calls HTTP 200 alone a successful test", async () => {
    setup([]);
    jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(2000);
    const report = await testIflow({ id: "Flow", body: "{}", waitSeconds: 1 });
    expect(report.outcome).toBe("unverified");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects response mismatch even if MPL completed", async () => {
    setup([
      {
        MessageGuid: "test-guid",
        Status: "COMPLETED",
        IntegrationArtifact: { Id: "Flow" },
      },
    ]);
    expect(
      (
        await testIflow({
          id: "Flow",
          body: "{}",
          expectedJson: { status: "different" },
        })
      ).outcome,
    ).toBe("failed");
  });
  it("does not use a message from another integration artifact", async () => {
    setup([
      {
        MessageGuid: "test-guid",
        Status: "COMPLETED",
        IntegrationArtifact: { Id: "OtherFlow" },
      },
    ]);
    jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(2000);
    expect(
      (await testIflow({ id: "Flow", body: "{}", waitSeconds: 1 })).outcome,
    ).toBe("unverified");
  });
  it("does not submit payloads to an artifact still starting", async () => {
    request.mockResolvedValue({ data: { d: { Status: "STARTING" } } });
    expect((await testIflow({ id: "Flow", body: "{}" })).outcome).toBe(
      "not-ready",
    );
    expect(send).not.toHaveBeenCalled();
  });
});
