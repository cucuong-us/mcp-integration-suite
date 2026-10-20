import com.sap.gateway.ip.core.customdev.util.Message
import groovy.util.XmlSlurper
import java.util.zip.ZipInputStream
import java.time.LocalDate

// Deliberately bounded OOXML reader, not a general-purpose Excel engine.
def secureXml(byte[] bytes) {
    String text = new String(bytes, 'UTF-8').replaceFirst(/^\uFEFF/, '')
    if (text =~ /(?i)<!DOCTYPE|<!ENTITY/) throw new IllegalArgumentException('XLSX_XML_DTD')
    def parser = new XmlSlurper(false, true)
    parser.setFeature('http://apache.org/xml/features/disallow-doctype-decl', true)
    parser.setFeature('http://xml.org/sax/features/external-general-entities', false)
    parser.setFeature('http://xml.org/sax/features/external-parameter-entities', false)
    return parser.parseText(text)
}

Message processData(Message message) {
    byte[] input = message.getBody(byte[].class)
    if (input == null || input.length == 0 || input.length > 2 * 1024 * 1024) throw new IllegalArgumentException('XLSX_SIZE')
    Map<String, byte[]> files = [:]
    def zip = new ZipInputStream(new ByteArrayInputStream(input))
    int expanded = 0, entries = 0
    try {
        def entry
        while ((entry = zip.nextEntry) != null) {
            if (++entries > 200) throw new IllegalArgumentException('XLSX_ENTRY_LIMIT')
            String name = entry.name
            if (name.startsWith('/') || name.contains('\\') || name.tokenize('/').contains('..') || name ==~ /(?i)^[a-z]:.*/) throw new IllegalArgumentException('XLSX_UNSAFE_PATH')
            if (entry.directory) continue
            if (files.containsKey(name)) throw new IllegalArgumentException('XLSX_DUPLICATE_ENTRY')
            def out = new ByteArrayOutputStream()
            byte[] chunk = new byte[8192]
            int count
            while ((count = zip.read(chunk)) != -1) {
                expanded += count
                if (out.size() + count > 4 * 1024 * 1024 || expanded > 8 * 1024 * 1024) throw new IllegalArgumentException('XLSX_EXPANDED_LIMIT')
                out.write(chunk, 0, count)
            }
            files[name] = out.toByteArray()
        }
    } finally { zip.close() }
    if (!files['xl/workbook.xml'] || !files['xl/_rels/workbook.xml.rels']) throw new IllegalArgumentException('XLSX_WORKBOOK_MISSING')
    if (files.keySet().any { it.toLowerCase().endsWith('vbaproject.bin') }) throw new IllegalArgumentException('XLSX_MACROS_UNSUPPORTED')
    def workbook = secureXml(files['xl/workbook.xml'])
    def sheets = workbook.sheets.sheet
    if (sheets.size() != 1 || sheets[0].@name.text() != 'PurchaseOrders') throw new IllegalArgumentException('XLSX_SHEET_CONTRACT')
    String relId = sheets[0].attributes().find { key, value -> key.toString().endsWith('}id') || key.toString() == 'id' }?.value?.toString()
    def relationships = secureXml(files['xl/_rels/workbook.xml.rels'])
    def rel = relationships.Relationship.find { it.@Id.text() == relId }
    if (!rel.size() || rel.@TargetMode.text() == 'External') throw new IllegalArgumentException('XLSX_SHEET_RELATIONSHIP')
    String target = rel.@Target.text()
    if (target.contains('..') || target.contains('\\') || target.contains(':')) throw new IllegalArgumentException('XLSX_SHEET_RELATIONSHIP')
    String sheetPath = target.startsWith('/xl/') ? target.substring(1) : 'xl/' + target
    if (!files[sheetPath]) throw new IllegalArgumentException('XLSX_SHEET_MISSING')
    List<String> strings = []
    if (files['xl/sharedStrings.xml']) {
        def shared = secureXml(files['xl/sharedStrings.xml'])
        strings = shared.si.collect { si -> si.depthFirst().findAll { it.name() == 't' }.collect { it.text() }.join('') }
    }
    List<Map> rows = []
    def sheet = secureXml(files[sheetPath])
    if (sheet.mergeCells.mergeCell.size()) throw new IllegalArgumentException('XLSX_MERGED_CELLS')
    sheet.sheetData.row.each { row ->
        if (rows.size() >= 1001) throw new IllegalArgumentException('XLSX_ROW_LIMIT')
        Map<String, Map> cells = [:]
        row.c.each { cell ->
            String ref = cell.@r.text()
            if (!(ref ==~ /[A-O][1-9][0-9]*/)) throw new IllegalArgumentException('XLSX_CELL_REFERENCE')
            String col = ref.replaceAll(/[0-9]/, '')
            if (cells.containsKey(col)) throw new IllegalArgumentException('XLSX_DUPLICATE_CELL')
            if (cell.f.size()) throw new IllegalArgumentException('XLSX_FORMULA_UNSUPPORTED')
            String type = cell.@t.text(), value
            if (type == 's') {
                String raw = cell.v.text()
                if (!(raw ==~ /[0-9]+/) || raw.length() > 8 || raw.toInteger() >= strings.size()) throw new IllegalArgumentException('XLSX_SHARED_STRING_INDEX')
                value = strings[raw.toInteger()]
            } else if (type == 'inlineStr') {
                value = cell.is.depthFirst().findAll { it.name() == 't' }.collect { it.text() }.join('')
            } else if (type in ['', 'n', 'str', 'd']) value = cell.v.text()
            else throw new IllegalArgumentException('XLSX_CELL_TYPE')
            if (value.length() > 256) throw new IllegalArgumentException('XLSX_CELL_LENGTH')
            cells[col] = [value:value.trim(), type:type]
        }
        if (cells.values().any { it.value }) rows << [number: row.@r.text(), cells:cells]
    }
    List<String> headers = ['OrderRef','CompanyCode','DocType','Vendor','PurchOrg','PurchGroup','Currency','ItemNo','Material','Plant','Quantity','Unit','NetPrice','PriceUnit','DeliveryDate']
    if (rows.size() < 2) throw new IllegalArgumentException('XLSX_EMPTY_DATA')
    List<String> actual = (0..<15).collect { i -> rows[0].cells[Character.toString((char)(65+i))]?.value ?: '' }
    if (actual != headers) throw new IllegalArgumentException('XLSX_HEADERS')
    boolean date1904 = workbook.workbookPr.@date1904.text() in ['1','true']
    List<Map> data = rows.drop(1).collect { row ->
        Map result = [_row:row.number]
        headers.eachWithIndex { header, i ->
            def cell = row.cells[Character.toString((char)(65+i))]
            String value = cell?.value ?: ''
            if (header in ['Vendor','Material'] && value && !(cell.type in ['s','inlineStr','str'])) throw new IllegalArgumentException('XLSX_IDENTIFIER_MUST_BE_TEXT')
            if (header == 'DeliveryDate' && value && cell.type in ['', 'n']) {
                if (!(value ==~ /[0-9]+(?:\.0+)?/)) throw new IllegalArgumentException('XLSX_DATE_SERIAL')
                long serial = new BigDecimal(value).longValueExact()
                if (serial < 1 || serial > 100000 || (!date1904 && serial == 60)) throw new IllegalArgumentException('XLSX_DATE_SERIAL')
                value = date1904 ? LocalDate.of(1904,1,1).plusDays(serial).toString() : LocalDate.of(1899,12,31).plusDays(serial > 60 ? serial-1 : serial).toString()
            }
            if (header == 'DeliveryDate' && value && cell.type == 'd') {
                if (!(value ==~ /[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T00:00:00(?:\.0+)?Z?)?/)) throw new IllegalArgumentException('XLSX_DATE_LITERAL')
                value = value.substring(0,10)
            }
            result[header] = value
        }
        result
    }
    message.setProperty('poRows', data)
    message.setProperty('parsedRows', data.size())
    message.setBody('<ExcelParsed rows="' + data.size() + '"/>')
    return message
}
