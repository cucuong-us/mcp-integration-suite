import com.sap.gateway.ip.core.customdev.util.Message
import groovy.util.XmlSlurper
import groovy.xml.MarkupBuilder
import groovy.json.JsonSlurper

Message processData(Message message) {
    String body = message.getBody(String)
    if (body.getBytes('UTF-8').length > 1024 * 1024 || body =~ /(?i)<!DOCTYPE|<!ENTITY/) throw new IllegalStateException('SMART_GATHER_XML')
    def parser = new XmlSlurper(false,true)
    parser.setFeature('http://apache.org/xml/features/disallow-doctype-decl',true)
    def doc = parser.parseText(body)
    def results = doc.depthFirst().findAll { it.name() == 'Result' }
    int expected = (message.getProperty('SmartExpectedCount') ?: 0) as int
    Set keys = [] as Set
    if (expected < 1 || results.size() != expected) throw new IllegalStateException('SMART_INCOMPLETE_BATCH')
    results.each { result ->
        String key = result.@key.text()
        if (result.@ok.text() != 'true' || !(key ==~ /[A-Za-z0-9_.:-]{1,100}/) || !keys.add(key)) throw new IllegalStateException('SMART_GATHER_RESULT')
    }
    def expectedKeys = new JsonSlurper().parseText((message.getProperty('SmartExpectedKeys') ?: '[]').toString()) as Set
    if (keys != expectedKeys) throw new IllegalStateException('SMART_GATHER_KEYS')
    def out = new StringWriter()
    new MarkupBuilder(out).BatchResult(status:'COMPLETE',count:expected) {
        results.each { result -> Result(key:result.@key.text(),ok:'true',httpStatus:result.@httpStatus.text()) }
    }
    message.setBody(out.toString())
    def log = messageLogFactory.getMessageLog(message)
    if (log != null) {
        log.addCustomHeaderProperty('SmartResult','COMPLETE')
        log.addCustomHeaderProperty('SmartRecordCount',expected.toString())
        log.addCustomHeaderProperty('SmartCase',(message.getProperty('SmartCase') ?: 'unspecified').toString())
    }
    return message
}
