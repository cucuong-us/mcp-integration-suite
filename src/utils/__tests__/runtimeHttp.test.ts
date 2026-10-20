import { sendRequestToCPI } from "../../api/messages/sendMessageToCPI";
jest.mock("../../api/api_destination", () => ({
  getOAuthToken: async () => ({
    http_header: { key: "Authorization", value: "Bearer test-token" },
  }),
}));
jest.mock("../../api/cpi_auth", () => ({
  getOAuthTokenCPI: async () => ({
    http_header: { key: "Authorization", value: "Bearer runtime-token" },
  }),
}));
describe("Runtime HTTP and CSRF", () => {
  const original = global.fetch;
  beforeEach(() => {
    process.env.CPI_BASE_URL = "https://runtime.invalid";
    global.fetch = jest.fn();
  });
  afterAll(() => {
    global.fetch = original;
  });
  it("fetches a CSRF token and keeps its session cookies for POST", async () => {
    (fetch as jest.Mock)
      .mockResolvedValueOnce(
        new Response("", {
          status: 200,
          headers: {
            "x-csrf-token": "csrf-test",
            "set-cookie": "session=abc; Secure; HttpOnly",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { sap_messageprocessinglogid: "message-123" },
        }),
      );
    const result = await sendRequestToCPI(
      "/http/test",
      "POST",
      "application/xml",
      "<test/>",
    );
    expect(result.messageGuid).toBe("message-123");
    expect((fetch as jest.Mock).mock.calls[0][1].method).toBe("HEAD");
    expect((fetch as jest.Mock).mock.calls[1][1].headers).toMatchObject({
      "X-CSRF-Token": "csrf-test",
      Cookie: "session=abc",
    });
  });
  it("stops before sending a payload if runtime authentication fails", async () => {
    (fetch as jest.Mock).mockResolvedValue(new Response("", { status: 403 }));
    await expect(
      sendRequestToCPI("/http/test", "POST", "text/plain", "payload"),
    ).rejects.toThrow("Runtime authentication");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("blocks cross-origin and caller-provided authentication headers", async () => {
    await expect(
      sendRequestToCPI("//evil.invalid", "POST", "text/plain", "payload"),
    ).rejects.toThrow();
    await expect(
      sendRequestToCPI("/http/test", "POST", "text/plain", "payload", [
        { key: "Authorization", value: "x" },
      ]),
    ).rejects.toThrow("managed");
    expect(fetch).not.toHaveBeenCalled();
  });
});
