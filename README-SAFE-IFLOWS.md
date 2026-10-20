# Tạo và kiểm thử iFlow qua MCP

Xem [chi tiết lỗi cũ, thay đổi code và kết quả kiểm thử](CHANGES-SAFE-IFLOWS.md) để đối chiếu bản này với repo gốc.

Bản mở rộng cho `1nbuc/mcp-integration-suite`, tập trung vào tạo/sửa iFlow có sơ đồ hoàn chỉnh, kiểm tra trước deploy và xác minh kết quả. Không thể bảo đảm mọi Groovy, mapping hoặc hệ thống đích bất kỳ đều không lỗi. Server chặn những lỗi đã biết, gọi SAP validation và phân biệt rõ kết quả đã xác minh với chưa xác minh.

## Chạy server

Khuyến nghị Node.js 22 LTS. Từ thư mục dự án:

```sh
npm ci --ignore-scripts
npm run build
npm test -- --runInBand --coverage=false
npm start
```

Server dùng stdio. Không gõ payload JSON thủ công vào terminal chạy server; kết nối bằng MCP client. `iflow-image` dùng Puppeteer và cần Chrome riêng; các tool tạo/kiểm tra/deploy không cần Chrome.

Copy `.env.example` thành `.env`, điền key trên máy của bạn. File `.env` không được đưa vào Git hay gói phân phối.

- `API_BASE_URL`: host quản trị + `/api/v1`.
- `API_OAUTH_*`: service key plan `api`, có quyền đọc/ghi/deploy phù hợp.
- `CPI_BASE_URL`: host runtime lấy từ `EntryPoints.Url`, thường khác host quản trị.
- `CPI_OAUTH_*`: service key plan `integration-flow`, có role phù hợp với HTTPS sender (thường `ESBMessaging.send`).

Key quản trị có thể lấy token và đọc API thành công nhưng không gọi được runtime. Không thay role của sender hoặc tắt CSRF để khắc phục lỗi quyền.

Ví dụ cấu hình cho MCP client hỗ trợ `mcpServers`:

```json
{
  "mcpServers": {
    "sap-cpi": {
      "command": "node",
      "args": ["C:/absolute/path/mcp-integration-suite/dist/index.js"]
    }
  }
}
```

## Quy trình tạo flow

1. Dùng `preview-iflow-blueprint` để biên dịch graph và kiểm tra cục bộ, chưa ghi lên SAP.
2. Dùng `create-iflow-from-blueprint` với package ID. Tool từ chối ID đã tồn tại, upload bundle và gọi SAP validation. Không tự deploy.
3. Dùng `validate-iflow-design`. Chỉ tiếp tục khi local valid và SAP passed.
4. Dùng `start-iflow-deployment`, giữ task ID và kiểm tra bằng `get-deployment-status`. Timeout không có nghĩa task đã dừng; không deploy lại chỉ vì chờ lâu.
5. Dùng `get-iflow-runtime-status`; cần `STARTED` trước khi test.
6. Mở editor SAP để xác minh UI và xem Problems. Local/SAP validation không tự chứng nhận tương thích toàn bộ editor.
7. Dùng `test-iflow` với payload và expected status/body/JSON. PASS cần assertion đúng và MPL duy nhất của đúng iFlow đạt trạng thái mong đợi.

`deploy-iflow` cũ vẫn có bước chờ giới hạn; nếu timeout, dùng task ID trong lỗi để tiếp tục quan sát.

## Blueprint

Xem JSON chạy được trong `resources/blueprints/`:

- `order10.json`: 10 flow nodes, kiểm tra XML order, Router, Message Mapping, XML→JSON và hai response branches.
- `McpJsonRoutingLab.blueprint.json`: JSON, Router ba nhánh, Groovy và Exception Subprocess.
- `McpHttpReceiverLab.blueprint.json`: Request-Reply/HTTPS receiver và Exception Subprocess; receiver dùng `https://example.com/` với dữ liệu test tổng hợp.
- `McpUnicodeBundleLab.blueprint.json`: Unicode trong nội dung và tên bundle ASCII dài cần fold manifest.

Hỗ trợ `start`, `end`, `contentModifier`, `groovy`, `router`, `xmlToJson`, `jsonToXml`, `messageMapping`, `generalSplitter`, `gather`, `multicast`, `sequentialMulticast`, `join`, `processCall`, `requestReply`, `send`, cùng `exceptionHandler`. Có HTTPS/Timer/SFTP sender, HTTP/JMS/SFTP/OData V2 receiver và `localProcesses`. Xem [bảng cấu hình và giới hạn từng thành phần](BLUEPRINT-COMPONENTS.md). Giới hạn 100 nodes/200 edges áp dụng trên toàn bundle. Các kiểu ngoài danh sách vẫn cần template SAP phù hợp và chưa được kiểm chứng bởi compiler này.

Các quy tắc quan trọng:

- Artifact ID/node ID/edge ID phải hợp lệ, duy nhất. Một start; có end; mọi node phải reachable và có đường tới end.
- Router có đúng một default branch; các branch còn lại có condition.
- Tên artifact theo ràng buộc SAP (ASCII letters/numbers/underscore/space/period/hyphen, không kết thúc bằng period). Nội dung payload vẫn hỗ trợ Unicode.
- Tên receiver không có khoảng trắng. HTTP/OData receiver yêu cầu HTTPS và không đặt credentials vào URL; JMS/SFTP có cấu hình riêng trong bảng thành phần.
- Cung cấp script dưới `src/main/resources/script/` và mapping/XSD tương ứng. Metadata component được lấy từ template SAP, không tự đoán phiên bản.
- `x/y` là tọa độ tùy chọn để bố trí nhánh. Compiler tự sinh BPMN shapes, bounds, edges, waypoints và references.
- HTTPS sender mặc định bật CSRF. `SAP_ApplicationID` được allow để test correlation; nếu bạn thay allowlist, phải giữ cơ chế correlation phù hợp.

## Cập nhật có bảo vệ

`update-iflow` vá file trực tiếp trong archive, giữ file/binary không thay đổi và thực hiện:

1. Local validation trước upload.
2. Lưu ZIP gốc vào `backups/`.
3. Đọc lại và so sánh nội dung từng entry để phát hiện chỉnh sửa khác; bỏ qua timestamp/compression của ZIP.
4. Upload rồi gọi SAP validation.
5. Nếu validation không passed, khôi phục khi có thể chứng minh bản hiện tại vẫn là bản vừa upload. Nếu phát hiện chỉnh sửa khác, dừng và trả đường dẫn backup.

Đây là bảo vệ trong một server process và kiểm tra trước ghi, không phải transaction/lock phân tán tuyệt đối trên SAP. Tránh chỉnh cùng artifact từ nhiều client trong lúc update. Không tự deploy bản rollback.

`appendMode` thực sự nối nội dung; path traversal/duplicate patch paths bị từ chối. Workspace tạm tách theo process và mỗi download.

## Kết quả test

Bản gốc mở rộng đã qua 56 unit tests (10 suites) và kiểm tra bốn flow cũ trong graphical editor. Sau khi bổ sung các thành phần mới, bộ offline có 75 tests (11 suites) pass, TypeScript build pass, chín flow mẫu mới qua SAP validation; năm flow nội bộ qua deployment SUCCESS và runtime STARTED. Các thành phần mới chưa được kiểm tra trong graphical editor. Đây chưa phải xác nhận payload chạy đúng: matrix HTTP runtime vẫn chưa được xác minh do thiếu key runtime phù hợp; JMS/SFTP/OData chưa được test với hệ thống đích. Xem [chi tiết bằng chứng và giới hạn](BLUEPRINT-COMPONENTS.md). Cần cấu hình `CPI_OAUTH_*` có quyền gửi message rồi chạy matrix bên dưới.

`test-iflow` chỉ gửi payload một lần. Không retry nghiệp vụ sau timeout. Kết quả:

- `passed`: response assertions đúng và MPL được xác minh.
- `failed`: assertion hoặc terminal MPL sai.
- `unverified`: không đủ bằng chứng/correlation, không được coi HTTP 200 là PASS.
- `not-ready`: runtime chưa Started, không gửi payload.

`npm test` mặc định chỉ chạy unit tests offline. Các test cũ trong `src/api/__tests__` có thể tạo/xóa artifact thật và đã được loại khỏi lệnh test mặc định. Dùng một package test riêng cho live tests; không chạy test cũ trên tenant production.

Sau khi cấu hình key runtime và tạo các flow mẫu, chạy 10 tình huống qua MCP thật:

```sh
node src/scripts/runtimeMatrix.cjs --live
```

Kết quả lưu tại `artifacts/runtime-report.json`. Suite dừng sớm khi runtime authentication thất bại để không gửi lặp payload. Có test order hợp lệ/thiếu ID/XML lỗi, ba nhánh JSON, JSON lỗi/Groovy exception, HTTPS receiver và Unicode.

## Tài liệu SAP

- https://help.sap.com/docs/integration-suite/sap-integration-suite/serviceendpoints-example-requests
- https://help.sap.com/docs/integration-suite/isuite-integrations-and-apis/update-and-validate-configuration-parameters
- https://help.sap.com/docs/integration-suite/sap-integration-suite/get-runtime-status-of-deployed-integration-flow
- https://help.sap.com/docs/integration-suite/sap-integration-suite/using-ids-to-filter-messages
