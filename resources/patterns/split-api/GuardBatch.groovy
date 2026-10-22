import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.xpath.XPathFactory
import javax.xml.xpath.XPathConstants
import javax.xml.namespace.NamespaceContext

Message processData(Message message) {
    def config = new JsonSlurper().parseText(new String('__CONFIG_BASE64__'.decodeBase64(),'UTF-8'))
    byte[] body = message.getBody(byte[].class)
    if (!body || body.length > 1024 * 1024) throw new IllegalArgumentException('SMART_INPUT_SIZE')
    def f = DocumentBuilderFactory.newInstance()
    f.setNamespaceAware(true)
    f.setFeature('http://apache.org/xml/features/disallow-doctype-decl',true)
    f.setFeature('http://xml.org/sax/features/external-general-entities',false)
    f.setFeature('http://xml.org/sax/features/external-parameter-entities',false)
    def doc = f.newDocumentBuilder().parse(new ByteArrayInputStream(body))
    def xp = XPathFactory.newInstance().newXPath()
    xp.setNamespaceContext([
        getNamespaceURI:{String p -> config.namespaces[p] ?: ''},
        getPrefix:{String uri -> config.namespaces.find {k,v -> v==uri}?.key},
        getPrefixes:{String uri -> config.namespaces.findAll {k,v -> v==uri}.keySet().iterator()}
    ] as NamespaceContext)
    def records = xp.evaluate(config.xpath,doc,XPathConstants.NODESET)
    if (records.length < 1 || records.length > config.maxRecords) throw new IllegalArgumentException('SMART_RECORD_COUNT')
    Set keys = [] as Set
    for (int i=0; i<records.length; i++) {
        def node = records.item(i)
        if (node.localName != config.recordElement) throw new IllegalArgumentException('SMART_BUSINESS_UNIT')
        String key = xp.evaluate(config.keyXPath,node).trim()
        if (!(key ==~ /[A-Za-z0-9_.:-]{1,100}/) || key in ['.','..'] || !keys.add(key)) throw new IllegalArgumentException('SMART_RECORD_KEY')
    }
    message.setProperty('SmartExpectedCount',records.length)
    message.setProperty('SmartExpectedKeys',JsonOutput.toJson(keys as List))
    message.setProperty('SmartBatchId',UUID.randomUUID().toString())
    message.setBody(body)
    return message
}
