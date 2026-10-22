# Thành phần blueprint được hỗ trợ

Các tool `preview-iflow-blueprint` và `create-iflow-from-blueprint` dùng cùng schema trong [`blueprintSchema.ts`](src/api/iflow/blueprintSchema.ts). Bản mở rộng bổ sung component metadata, graph validation, diagram và các ví dụ bên dưới; số MCP tools vẫn là 35.

## Flow steps

| Thành phần | `nodes[].type` | Cấu hình chính |
| --- | --- | --- |
| Start / End | `start` / `end` | Mỗi process có một start và ít nhất một end. |
| Content Modifier | `contentModifier` | `properties` dùng các key SAP, ví dụ `bodyType`, `wrapContent`. |
| Groovy | `groovy` | `properties.script`, kèm resource trong `src/main/resources/script/`. |
| Router | `router` | Ít nhất hai outgoing edges, đúng một default, nhánh khác có condition. |
| XML to JSON | `xmlToJson` | SAP converter properties. |
| JSON to XML | `jsonToXml` | Mặc định thêm root `root`; có thể cấu hình `addXMLRootElement`, `additionalRootElementName` và namespace. |
| Message Mapping | `messageMapping` | Bundle phải có mapping/XSD được tham chiếu. |
| XSLT Mapping | `xsltMapping` | `properties.mappinguri`: `dir://mapping/xslt/src/main/resources/mapping/Name.xsl`; phải bundle resource tương ứng. Chỉ hỗ trợ mapping trong iFlow. |
| XML Validator | `xmlValidator` | `properties.xsd`: `/xsd/Name.xsd`; phải bundle XSD trong `src/main/resources/xsd/`. Dừng khi schema không hợp lệ, không cho suppress exception. |
| General Splitter | `generalSplitter` | Bắt buộc `properties.splitExprValue`, ví dụ `//item`. Template mặc định XPath, streaming và xử lý tuần tự. |
| Gather | `gather` | Template mặc định PlainText/concatenate; phải có Splitter upstream hoặc Join ngay trước. Không tự đoán XPath cho chiến lược XML. |
| Parallel Multicast | `multicast` | Ít nhất hai nhánh, khai báo `joinId` của node Join cùng process. |
| Sequential Multicast | `sequentialMulticast` | Như parallel; thứ tự nhánh theo thứ tự outgoing edges trong JSON. Compiler sinh lại routing sequence table. |
| Join | `join` | Gom các nhánh của đúng một Multicast. Muốn ghép nội dung, đặt Gather sau Join. |
| Process Call | `processCall` | Bắt buộc `processId` trỏ tới `localProcesses[].id`. |
| Request Reply | `requestReply` | Receiver HTTP hoặc OData V2. |
| Send | `send` | Receiver JMS hoặc SFTP; không mô hình hóa thành Request Reply đồng bộ. |

`edges[].name` là tùy chọn; nhánh Multicast luôn được đặt tên, mặc định bằng edge ID. Các nhánh phải quay về Join đã khai báo, không được merge trước Join hoặc đi tắt ra end. Không hỗ trợ raw sequence cycles, recursive Process Call, hoặc kết nối sequence flow xuyên process.

Exception Subprocess vẫn được cấu hình bằng `exceptionHandler`, có script Groovy đi kèm. Giới hạn toàn bundle là 100 nodes/200 edges, tối đa 20 local processes. Các phiên bản Splitter/adapter khác, như Iterating Splitter và OData V4, chưa nằm trong schema này.

`exceptionHandler.end` nhận `message` (mặc định để tương thích flow cũ) hoặc `error`. Chọn `error` khi script xử lý lỗi cần return bình thường sau khi ghi metadata nhưng MPL vẫn phải FAILED. Compiler sinh Error End Event từ template SAP và dùng IDs theo mẫu export cho Exception Subprocess. Timer start cũng chỉ đặt metadata ở `timerEventDefinition`, phù hợp cấu trúc export SAP.

Bài test nghiệp vụ [Excel PO → IDoc dry-run](resources/scenarios/excel-po-dryrun/README.md) dùng các khả năng này để kiểm tra thực thi Groovy, mapping ứng viên và error path; không gửi IDoc tạo PO.

## Sender

Sender là cấu hình ở cấp blueprint, không phải một node adapter riêng:

- Mặc định `sender: {"type":"https"}`: bắt buộc `endpoint`, CSRF mặc định bật. Blueprint cũ không khai báo sender tiếp tục dùng HTTPS.
- `sender: {"type":"timer","runOnce":true}`: chạy một lần khi deploy. Không khai báo `endpoint`; compiler bỏ participant/channel HTTPS và thêm timer event definition.
- Timer định kỳ: thay `runOnce` bằng `scheduleKey` là bảng scheduler row/cell đã export từ SAP. Không truyền đồng thời cả hai. Compiler kiểm tra XML và giữ nguyên bảng; chưa có bộ biên dịch cron cấp cao.
- SFTP sender: khai báo `type`, `host`, `directory`, `fileName`, `credentialName`, `scheduleKey` và **`postProcessing: "delete"`**. Đây là lựa chọn xóa file sau khi xử lý thành công, phải được chọn tường minh; các chế độ post-processing khác chưa được hỗ trợ. Mẫu chỉ dùng host `.example.com` và không được deploy trong live checks.

`credentialName` là alias Security Material đã tồn tại trên tenant, không phải password. SFTP sender vẫn cần scheduler hợp lệ, credentials và SSH known hosts đúng với hệ thống thực tế.

## Receiver

| Adapter | Receiver config | Step |
| --- | --- | --- |
| HTTP | `type: "http"` (hoặc bỏ `type` để tương thích cũ), `url`, `method`, `name` | `requestReply` |
| JMS | `type: "jms"`, `queue`, `name` | `send` |
| SFTP | `type: "sftp"`, `host`, `directory`, `fileName`, `credentialName`, `name` | `send` |
| OData V2 | `type: "odataV2"`, `url`, `resourcePath`, `edmx`, `operation`, `queryOptions`, tùy chọn `credentialName` | `requestReply` |

HTTP/OData yêu cầu HTTPS, không nhúng credentials vào URL. OData mặc định `Query(GET)`, hỗ trợ thêm `Read(GET)`, `Create(POST)`, `Update(PUT)`, `Delete(DELETE)` ở schema; chưa kiểm thử kết nối/business behavior của từng operation. `edmx` phải trỏ tới resource `.edmx` đã cung cấp trong `src/main/resources/edmx/`. Timeout mặc định là 60 **giây**, không phải milliseconds. OData dùng authentication None hoặc Basic qua alias; các kiểu auth khác chưa có cấu hình cấp cao.

JMS ở phiên bản này hỗ trợ **receiver**, chưa thêm JMS sender. SFTP receiver dùng user/password Security Material alias và Internet proxy theo template; các mode SSH private key/Cloud Connector chưa expose trong receiver schema. Các adapter ngoài các biến thể ghi ở bảng không được tự nhận là đã hỗ trợ.

## Local Integration Process

Khai báo `localProcesses` như một danh sách graph, mỗi graph có `id`, `name`, `nodes`, `edges`. Node `processCall` trong main process hoặc local process khác dùng `processId` để gọi. Compiler tạo process/pool riêng và giữ đúng scope của node/sequence flow. IDs phải duy nhất trên toàn bundle, không chỉ trong từng process.

Compiler chuẩn hóa ID nội bộ của local process theo mẫu SAP export (`Process_Local_…`, `StartEvent_Local_…`, `CallActivity_Local_…`, `SequenceFlow_Local_…`) và sửa tất cả references tương ứng. Blueprint vẫn dùng ID logic ban đầu; preview trả `idMap` để đối chiếu. Trên tenant thử nghiệm, ID tùy ý đã qua validation/build nhưng gây lỗi runtime route không có outputs; biến thể theo mẫu ID SAP lên STARTED. Đây là hành vi quan sát trên tenant, không khẳng định là quy tắc ID được tài liệu SAP bảo đảm cho mọi phiên bản.

Ví dụ hoàn chỉnh: [`McpLocalProcessConverterLab.json`](resources/blueprints/McpLocalProcessConverterLab.json).

## Ví dụ và kiểm chứng

Các ví dụ bổ sung:

- [Splitter và Gather](resources/blueprints/McpSplitterGatherLab.json)
- [Parallel Multicast, Join và Gather](resources/blueprints/McpParallelMulticastLab.json)
- [Sequential Multicast, Join và Gather](resources/blueprints/McpSequentialMulticastLab.json)
- [Local Process và JSON to XML](resources/blueprints/McpLocalProcessConverterLab.json)
- [Timer run once](resources/blueprints/McpTimerRunOnceLab.json)
- [JMS receiver](resources/blueprints/McpJmsReceiverLab.json)
- [SFTP receiver](resources/blueprints/McpSftpReceiverLab.json)
- [SFTP sender](resources/blueprints/McpSftpSenderLab.json)
- [OData V2 receiver với EDMX](resources/blueprints/McpODataV2ReceiverLab.json)

SAP validation của các mẫu được kiểm tra trên package thử nghiệm riêng. Các adapter ngoài tenant không được deploy chỉ để kiểm tra cấu trúc. `test-iflow` hiện gửi POST vào HTTPS REST endpoint; không tự trigger Timer, poll SFTP hay tạo/consume JMS message.

Kết quả ngày 2026-10-20:

[Bản ghi kiểm chứng đã loại thông tin tenant](docs/extended-components-verification-2026-10-20.json) lưu trạng thái từng ví dụ; đây là kết quả tại thời điểm kiểm tra, không phải bảo đảm mọi cấu hình tương lai đều chạy được.

| Kiểm tra | Bằng chứng |
| --- | --- |
| Offline tests và TypeScript | 75 tests, 11 suites pass; TypeScript build pass. Các ví dụ cũ tiếp tục compile hợp lệ. |
| Chín blueprint mới ở trên | SAP validation Passed trên các artifact test riêng. |
| Splitter/Gather, parallel Multicast, sequential Multicast, Local Process/JSON to XML, Timer | Năm artifact deployment SUCCESS và runtime STARTED. Local Process đã được sửa và deploy lại sau khi phát hiện lỗi route rỗng ở bản ID tùy ý. |
| JMS receiver, SFTP sender/receiver, OData V2 receiver | Chỉ kiểm tra cấu trúc và SAP validation; không deploy/test kết nối thật. |
| Payload/MPL | Chưa xác nhận business execution của các flow mới. Timer có một MPL DISCARDED khi kiểm tra; không tính là message chạy thành công. HTTP cases cần runtime credentials phù hợp. |
| Timer định kỳ và cấu hình adapter nâng cao | Chỉ có kiểm tra schema/cấu trúc cho scheduleKey nhập từ SAP; chưa chứng nhận mọi lịch, operation hoặc kiểu xác thực. |

Hai yêu cầu từ SAP validation đã được đưa vào code và regression checks: nhánh Multicast phải có tên; OData timeout phải tính bằng giây, giá trị 1–300. SFTP sender hiện chỉ expose giá trị post-processing `delete` đã xác minh với SAP, và yêu cầu người tạo chọn tường minh.

Nguồn template, phiên bản và license: [component templates](resources/component-templates/README.md). Luôn phân biệt local validation, SAP validation, deployment, runtime STARTED, editor UI và kết quả payload/MPL. API giữ `editorVerified: false`; các thành phần mới chưa được xác minh trong editor do Computer Use dừng vì không xác định chắc URL cửa sổ Chrome.

## Planning, typed settings and process-scoped errors

See [COMPONENT-INTELLIGENCE.md](COMPONENT-INTELLIGENCE.md) for the 18-component decision catalog, eight planning goals and sample-based semantic analysis. Node `splitter`/`gather` settings compile to SAP properties and reject conflicting raw values. HTTP receivers support Basic/OAuth aliases, GET/HEAD/POST/PUT/PATCH/DELETE, timeout in milliseconds, header allowlists and explicit error policy. Main and `localProcesses[]` may each declare `exceptionHandler`; the handler is emitted inside its own process with unique IDs and diagram. Main handlers alone are insufficient for some local worker errors, as demonstrated by the runtime regression.
