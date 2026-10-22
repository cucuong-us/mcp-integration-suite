# Chi tiết thay đổi so với repo gốc

Tài liệu này mô tả bản mở rộng trong commit [`9e8c8e7`](https://github.com/cucuong-us/mcp-integration-suite/commit/9e8c8e7cbba6a5d0de8653835efd9d51686a2d0c), so với commit gốc `38b771644432724d67596046796074863d7cc9e5` của `1nbuc/mcp-integration-suite`. Commit triển khai thay đổi 43 file; commit bổ sung tài liệu này không thay đổi logic server.

Bản bổ sung tiếp theo mở rộng Timer, Splitter/Gather, Multicast/Join, Local Process, JSON to XML và adapter JMS/SFTP/OData V2. Xem [phạm vi mới, ví dụ và kết quả kiểm thử ngày 2026-10-20](BLUEPRINT-COMPONENTS.md). Các con số 56 tests/bốn flow dưới đây là kết quả lịch sử của commit `9e8c8e7`; bộ hiện tại đã tăng lên 75 tests/11 suites.

Bài test tiếp theo [Excel PO → IDoc dry-run](resources/scenarios/excel-po-dryrun/README.md) bổ sung 28 ca Groovy thật, ba ca thực thi CPI/MPL và nâng Jest lên 78 tests/12 suites. Bài test cũng dẫn tới sửa cấu trúc timer, chuẩn hóa ID Exception Subprocess và thêm lựa chọn Error End để giữ trạng thái FAILED sau khi ghi metadata. Các kết quả lịch sử bên dưới không thay thế bằng chứng nghiệp vụ trong bài test mới.

## 1. Lỗi và hạn chế đã sửa

Không phải mọi thay đổi dưới đây đều là lỗi vi phạm tài liệu SAP. Có lỗi logic trong code, có cách đọc response không đúng với tenant đã kiểm tra, và có những biện pháp bảo vệ trước đây chưa có.

| Vị trí | Hành vi trước đây và ảnh hưởng | Thay đổi |
| --- | --- | --- |
| [`getEndpointUrl.ts`](src/utils/getEndpointUrl.ts), [`iflow/index.ts`](src/api/iflow/index.ts) | Tách chuỗi từ `ServiceEndpoints.Id` rồi tự ghép host và protocol prefix; ID không phải nguồn đáng tin cậy để dựng đường dẫn runtime. | Lấy URL SAP cung cấp trong `EntryPoints.Url`, bổ sung lấy `EntryPoints` trong request. Không đoán endpoint từ opaque ID. |
| [`mappings/index.ts`](src/api/mappings/index.ts): `deployMapping` | Điều kiện kiểm tra bị ngược: response có body lại đi vào nhánh báo thiếu task ID. | Chỉ chấp nhận task ID là chuỗi không rỗng; thiếu task ID phải báo rõ, không polling với ID rỗng. |
| [`deployment.ts`](src/api/deployment.ts) | Vòng chờ deployment có thể chạy mãi khi trạng thái giữ ở `DEPLOYING`. | Thêm timeout mặc định 120 giây và kiểm tra task ID. Timeout giữ task ID trong lỗi để tiếp tục quan sát, không tự trigger deploy lần nữa. |
| [`handlers/iflow/tools.ts`](src/handlers/iflow/tools.ts): `get-deploy-error` | Mô tả tool khẳng định response rỗng nghĩa là deploy thành công. | Bỏ kết luận này; deployment status và runtime readiness phải được kiểm tra riêng. |
| [`messageLogs.ts`](src/api/messages/messageLogs.ts): ErrorInformation | Đọc response bằng `.data.d.results`, dù response đang xử lý là một entity. | Đọc bằng `.data.d`. |
| [`messageLogs.ts`](src/api/messages/messageLogs.ts): attachment | Đọc trường `name` trong raw response, không đúng casing của trường trả về. | Đọc trường `Name`. |
| [`fileBasedUtils.ts`](src/utils/fileBasedUtils.ts): `patchFile` | Append xong tiếp tục chạy `writeFile`, khiến nội dung cũ bị ghi đè. | Return ngay sau append; tạo thư mục cha và kiểm tra đường dẫn nằm trong thư mục artifact. |
| [`messageLogs.ts`](src/api/messages/messageLogs.ts): `createMappingTestIflow` | Xóa `if_echo_mapping` rồi tạo lại, có thể làm mất chỉnh sửa đang có trong artifact đó. | Tạo artifact mới với ID UUID, trả ID và endpoint cho client. Không xóa/reset artifact cố định. |
| Mô tả tool update iFlow/mapping và mapping examples | Hướng dẫn đặt script trong `src/main/resources/scripts`. | Sửa thành `src/main/resources/script`, phù hợp bundle được kiểm chứng. |
| [`package.json`](package.json) | `main` và `npm start` trỏ tới `dist/server.js`, khác entrypoint build hiện tại. | Đổi thành `dist/index.js`. |
| [`zip.ts`](src/utils/zip.ts), [`exitHandler.ts`](src/utils/exitHandler.ts), diagram helper | Dùng đường dẫn tạm theo artifact ID, và cleanup toàn bộ thư mục temp; nhiều phiên có thể ảnh hưởng nhau. | Thư mục tạm riêng theo process và từng lần tải; cleanup chỉ phần của process hiện tại. SIGTERM cleanup rồi thoát. |

**Điểm đã kiểm tra và giữ nguyên:** filter `ServiceEndpoints.Name` bằng iFlow ID vẫn được giữ. Response thực tế trên tenant thử nghiệm hỗ trợ cách đó; không coi đây là lỗi của repo gốc và không đổi sang display name.

## 2. Quy trình update có backup và rollback có điều kiện

Trước đây, server tải artifact, giải nén, sửa file, đóng ZIP và upload mà chưa có quy trình validation/backup/rollback tương ứng. `update-iflow` và update Message Mapping nay dùng chung [`safeDesign.ts`](src/api/iflow/safeDesign.ts).

Quy trình mới:

1. Tải ZIP hiện tại và vá trực tiếp các entry được yêu cầu, giữ nội dung tài nguyên không sửa, kể cả binary.
2. Kiểm tra cấu trúc bản mới trước upload; từ chối đường dẫn không hợp lệ và patch trùng đường dẫn.
3. Lưu ZIP gốc vào `backups/`, nằm ngoài Git.
4. Tải lại artifact trước upload, so sánh nội dung từng entry để phát hiện chỉnh sửa đồng thời.
5. Upload; với iFlow, gọi `ValidateIntegrationDesigntimeArtifact` của SAP.
6. Nếu SAP validation failed hoặc không xác minh được, chỉ rollback khi bản hiện tại vẫn khớp bản vừa upload. Nếu có thay đổi khác hoặc không chứng minh được điều đó, dừng và trả đường dẫn backup.

SAP có thể thay timestamp ZIP và comment timestamp trong properties khi export lại. Phép so sánh bỏ qua metadata ZIP và comment/blank lines trong hai properties file được xử lý, đồng thời giữ các dòng giá trị và continuation. Nhờ đó không báo xung đột chỉ vì SAP export lại cùng nội dung.

Khóa theo artifact chỉ có hiệu lực trong một server process. Kiểm tra trước ghi và rollback có điều kiện không tạo thành transaction hoặc khóa phân tán tuyệt đối trên SAP. Upload timeout được báo là kết quả chưa xác minh; server không khẳng định upload chưa xảy ra và không tự retry.

Standalone Message Mapping được kiểm tra ZIP/XML và chấp nhận HTTP success 2xx cho update. Quy trình này **chưa xác nhận SAP compile mapping thành công**. Update và rollback không tự deploy.

## 3. Tạo iFlow từ blueprint và kiểm tra cấu trúc

[`blueprint.ts`](src/api/iflow/blueprint.ts) nhận graph JSON, dùng metadata component từ template SAP có sẵn để sinh bundle. Compiler tạo flow nodes, connections, BPMN diagram shapes/bounds/waypoints, manifest và tài nguyên script/mapping liên quan.

Các thành phần đang hỗ trợ:

- Start và End.
- Content Modifier, Groovy và Router.
- Message Mapping và XML to JSON.
- HTTP Request-Reply với HTTPS receiver.
- Exception Subprocess qua cấu hình `exceptionHandler`.

Schema từ chối trường không hỗ trợ; không âm thầm bỏ qua cấu hình mà compiler chưa biết xử lý. Graph giới hạn 100 nodes/200 edges; kiểm tra ID, một start, end, reachability, đường tới end và default branch của router. Receiver dùng HTTPS, tên receiver không có khoảng trắng và URL không chứa credentials. HTTPS sender mặc định bật CSRF và cho phép `SAP_ApplicationID` phục vụ test correlation.

[`designValidation.ts`](src/utils/designValidation.ts) bổ sung kiểm tra:

- ZIP paths và giới hạn giải nén: tối đa 1.000 entries, 16 MiB mỗi file, 64 MiB tổng nội dung.
- Manifest và file thiết kế cần thiết; parse XML, từ chối DTD/entities.
- ID trùng, reference, incoming/outgoing và component metadata.
- Diagram shapes, bounds, edges và waypoints.
- Tài nguyên script/mapping được tham chiếu có tồn tại trong bundle.

Đối với lỗi “deploy được nhưng editor không mở được”, các thay đổi này giúp sinh đầy đủ dữ liệu sơ đồ và phát hiện nhiều lỗi cấu trúc trước upload. Không thể kết luận mọi lỗi editor đều có cùng nguyên nhân. Kết quả API luôn giữ `editorVerified: false`; việc mở được editor được kiểm chứng riêng bằng UI.

## 4. Bảy MCP tools mới

Các tool đăng ký tại [`handlers/iflow/design.ts`](src/handlers/iflow/design.ts). Tổng server sau thay đổi là 35 tools.

| Tool | Chức năng và điều kiện |
| --- | --- |
| `preview-iflow-blueprint` | Compile blueprint và kiểm tra cục bộ, chưa ghi lên SAP. |
| `create-iflow-from-blueprint` | Tạo artifact mới và gọi SAP validation; từ chối ID đã tồn tại, không tự deploy. |
| `validate-iflow-design` | Kiểm tra local design và SAP validation; chỉ đánh dấu sẵn sàng deploy khi cả hai đạt. |
| `get-iflow-runtime-status` | Đọc trạng thái runtime để phân biệt build/deploy thành công với runtime đã `STARTED`. |
| `start-iflow-deployment` | Validate rồi trigger deploy một lần, trả task ID ngay. |
| `get-deployment-status` | Theo dõi task đã có, không khởi động lại deployment. |
| `test-iflow` | Gửi payload và đối chiếu response cùng Message Processing Log (MPL) của đúng iFlow. |

`deploy-iflow` cũ cũng được thêm bước kiểm tra design trước deployment.

## 5. Kiểm thử runtime và xử lý HTTP

[`testIflow.ts`](src/api/iflow/testIflow.ts) yêu cầu runtime `STARTED`, chọn một HTTPS REST endpoint từ response SAP và gửi payload POST đúng một lần. Tool kiểm tra HTTP status, body chứa chuỗi mong đợi hoặc JSON subset. Không tự gửi lại business message khi timeout.

Mỗi lần test có `SAP_ApplicationID` riêng. Tool tìm MPL bằng Message GUID từ response nếu có, hoặc ApplicationMessageId; sau đó kiểm tra đúng artifact ID. Nhiều MPL khớp sẽ bị từ chối vì kết quả mơ hồ.

- `passed`: tất cả response assertions đúng và MPL đạt trạng thái mong đợi.
- `failed`: assertion sai hoặc terminal MPL không đúng kỳ vọng.
- `unverified`: chưa có đủ bằng chứng MPL/correlation để kết luận.
- `not-ready`: runtime chưa Started, không gửi payload.

[`sendMessageToCPI.ts`](src/api/messages/sendMessageToCPI.ts) thêm HEAD handshake để lấy CSRF token/cookie trước request có bảo vệ, timeout HTTP và chặn client ghi đè các header auth/session. Request path phải tương đối trong cùng origin; không tự theo redirect. Bỏ logging trực tiếp payload/header và bổ sung redaction secret/Bearer/JWT trong [`logging.ts`](src/utils/logging.ts).

`.env.example` giải thích riêng management API credentials và runtime credentials. Tool ưu tiên `CPI_OAUTH_*` khi có đủ cấu hình; fallback management token không bảo đảm quyền runtime. HTTP 401/403 ở bước CSRF được báo rõ cần key runtime có sender role phù hợp.

## 6. Ví dụ, build và tests

Thêm bốn blueprint trong [`resources/blueprints`](resources/blueprints):

- `order10.json`: 10 flow nodes, XML order validation, Router, Message Mapping và XML to JSON.
- `McpJsonRoutingLab.blueprint.json`: JSON routing ba nhánh và Exception Subprocess.
- `McpHttpReceiverLab.blueprint.json`: HTTPS Request-Reply và Exception Subprocess, dùng receiver `https://example.com/` với dữ liệu tổng hợp.
- `McpUnicodeBundleLab.blueprint.json`: Unicode payload, XML escaping và tên artifact ASCII dài để kiểm tra manifest folding.

Thêm [`runtimeMatrix.cjs`](src/scripts/runtimeMatrix.cjs) và [`runtime-matrix.json`](resources/testcases/runtime-matrix.json), gồm 10 tình huống: order hợp lệ/thiếu ID/XML lỗi, ba nhánh JSON, JSON lỗi/Groovy exception, HTTPS receiver và Unicode. Runner yêu cầu `--live` và đủ runtime credentials, dừng sớm khi authentication thất bại; report lưu trong `artifacts/` ngoài Git.

Thêm regression tests cho design validation, update/rollback/concurrent edits, runtime HTTP và response/MPL assertions; cập nhật tests endpoint, append và ZIP. `npm test` mặc định loại các test cũ trong `src/api/__tests__` vì chúng có thể tạo/xóa artifact thật. Đây là tách live tests khỏi lệnh offline, không phải xác nhận các test live cũ đã pass.

Thêm XML parser `@xmldom/xmldom`, commit `package-lock.json` để cài dependency nhất quán và điều chỉnh TypeScript `isolatedModules`. `.gitignore` loại credentials, backups, runtime reports và thư mục scratch `work/`.

## 7. Bằng chứng kiểm thử và giới hạn còn lại

Kết quả tại thời điểm bàn giao bản triển khai:

| Kiểm tra | Kết quả |
| --- | --- |
| Unit tests offline | 56 tests, 10 suites pass. |
| Build | Build và TypeScript compile pass. |
| MCP protocol | Initialize, tools/list và các bước tạo/validate/deploy/status được kiểm tra; expose 35 tools. |
| Bốn flow mẫu trên tenant thử nghiệm | SAP validation Passed, deployment SUCCESS và runtime STARTED. |
| Graphical editor | Cả bốn flow mở được; order flow đã vào Edit và Cancel. Order flow vẫn có hai warning type inference ở chuỗi Content Modifier/Mapping/XML to JSON. |
| Rollback thực tế | Update sai tên receiver trên artifact test làm SAP validation Failed; server rollback, nội dung khớp bản gốc và validate lại Passed. |
| Mười tình huống payload runtime | **Chưa được xác minh**. Key hiện có nhận HTTP 401 ở runtime; cần cấu hình `CPI_OAUTH_*` với quyền gửi message phù hợp rồi chạy matrix. |

Validation Passed, deployment SUCCESS, runtime STARTED và editor mở được là các bằng chứng riêng. Chúng chưa xác nhận payload nghiệp vụ đi qua mọi nhánh đúng kết quả. Compiler cũng chưa hỗ trợ mọi SAP component, mọi Groovy/mapping hoặc mọi hệ thống đích.

Xem [hướng dẫn sử dụng](README-SAFE-IFLOWS.md) để cấu hình, tạo flow và chạy test. Các liên kết tài liệu SAP được giữ ở cuối hướng dẫn đó. Credentials và dữ liệu/log riêng của tenant không được đưa vào repository.

## 2026-10-21 — Refactor Excel PO dry-run to native CPI components

The previous dry-run had eight Groovy steps in the main process. Fixture loading, IDoc XML construction and simulated delivery were implemented as scripts even though standard CPI steps can handle them.

- Add blueprint node types xsltMapping and xmlValidator using exported component metadata from the existing pinned cpilint source. Require bundled resources; reject header-selected mapping and validators that suppress errors.
- Replace the generated fixture-loader script with Content Modifier (base64 body and explicit test properties). The bounded Excel reader decodes only when fixtureEncoding=base64; normal XLSX bytes remain supported.
- Replace MapCandidateIdocs.groovy with a reviewable XSLT 1.0 resource executed by native XSLT Mapping. Keep the candidate batch, TESTRUN flag, field values, grouping and leading-zero behavior.
- Add native XML Validators before and after mapping, with two project-owned XSD contracts. These are local dry-run contracts, never backend-certified PORDCR103 schemas; backendSchemaVerified remains false.
- Replace simulated-delivery script with Content Modifier setting NOT_POSTED and explicit no-posting metadata.
- Combine master-fixture checks with PO business validation; combine semantic mapping audit, dry-run guards and MPL metadata in AuditDryRun.groovy. Retain independent semantic checks because schema validity alone cannot detect wrong field values.
- Keep ten main nodes: Timer, two Content Modifiers, three Groovy steps, two XML Validators, one XSLT Mapping and End. Retain a separate exception-handler script plus Error End.
- Improve offline runner to follow the blueprint and execute the bundled Groovy/XSLT/XSD. Add six rejection probes for native schemas, corrupted mapped values and disabled dry-run, plus compiler/ZIP missing-resource checks.
- Add --package and explicit --create-package options to live runner; resume stays read-only. The old lab package was absent, so live verification used a new isolated package.

Validation: TypeScript compile; 81 Jest tests / 12 suites; 28 workbook cases and 6 component/guard probes. Three isolated CPI artifacts passed SAP validation, deployed SUCCESS and reached STARTED. Valid MPL COMPLETED with 2 PO/3 items; zero quantity and unknown vendor produced the expected FAILED status and error metadata. Reports: docs/excel-po-native-verification-2026-10-21.json and docs/excel-po-native-offline-2026-10-21.json.

Limits: no business receiver, SFTP/IDoc I/O, backend master-data lookup, backend-exported schema, real PO or editor UI verification. No performance improvement is claimed without measurement. Native-validator failure probes run offline; the two live negative cases fail in business validation before XML Validator.

## 2026-10-22 — Component planning, guarded split/API patterns and process-scoped errors

Before this change the compiler could construct components but lacked a decision workflow, typed Splitter execution policy, HTTP auth/timeout/header settings and local-process error handlers. An upstream Splitter alone was enough for the old Gather check; API response contracts and complete-result reconciliation were left to callers.

- Add get-iflow-component-catalog (an exhaustive decision record for the 18 supported node types), plan-iflow (eight structured goals with needs-input outcomes), and analyze-iflow-blueprint (formats, sample record boundaries, namespaces, split/Gather path pairing, swallowed errors, HTTP routes and partial side effects). Preview/create return analysis; known semantic errors block compilation.
- Add typed Splitter business unit/element/XPath, grouping, streaming, concurrency and error policy; typed Gather XML/text strategies; runtime namespace mappings. Reject conflicts with raw properties and bound analyzer path-state expansion.
- Extend HTTP receiver with Basic/OAuth2 Client Credentials aliases, PATCH/HEAD, timeout milliseconds, request/response header allowlists, explicit sendBody, throw/route error policy and optional validated record-key path suffix. Disable inherited retries and failure attachments. Source identifiers map to actual SAP export values, including OAuth2 Client Credentials with spaces.
- Generate a complete split-api blueprint from an explicit normalized-XML contract. Guard record count/unique business keys, unwrap General Splitter ancestors with native XSLT, call one local worker per whole record, assert HTTP and JSON/XML/text business responses, Gather XML summaries, then assert the exact key set and count. Sample payloads are not embedded in production resources. Do not claim receiver-side idempotency merely because a header is set.
- Add exceptionHandler to localProcesses. Emit each handler, Error End, references and diagram in the owning process. Correct local pool layout and warn when an API worker has no local handler. Runtime testing found a main-only handler left worker errors FAILED without custom metadata; the worker-local handler now records the expected error and preserves FAILED.
- SAP semantic validation caught two additional metadata constraints: dormant SplitterThreads must still be >=2 when ParallelProcessing=false; header table source type is lowercase xpath. Regression checks preserve these exported forms.
- Add loopback HTTP/Groovy/XSLT tests with call counts and whole-record assertions; CPI tests execute actual sequential/parallel Splitter, local worker, native mapping/Gather and both success/error handling. HTTP auth designs are SAP-validated without deploying business receivers.

Reports: docs/component-intelligence-live-2026-10-22.json and docs/component-intelligence-mock-2026-10-22.json. See COMPONENT-INTELLIGENCE.md and resources/plans/SmartPurchaseOrderApi.json for usage.

Limits: this is rule-based guidance for the current schema, not support for every SAP palette component. Unknown script semantics, backend schema/auth/I/O, pagination, retry orchestration, exactly-once and business transaction rollback are not certified. Native CPI tests substitute HTTP transport with synthetic responses; real HTTP transport failure cases execute against a loopback mock in the local harness. Editor UI is unverified.

Final validation for 2026-10-22: TypeScript compilation passed; 115 tests / 13 suites passed; 21 loopback mock cases passed; prior Excel 28 cases + 6 probes passed. CPI sequential/parallel cases completed with exact record count/key set; the rejected business response failed with worker-local SMART_BUSINESS_RESPONSE metadata. All three HTTP auth designs passed SAP validation.
