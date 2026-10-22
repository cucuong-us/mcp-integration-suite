import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurper
import groovy.xml.MarkupBuilder
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.xpath.XPathFactory
import javax.xml.namespace.NamespaceContext

Message processData(Message message) {
    def config = new JsonSlurper().parseText(new String('__CONFIG_BASE64__'.decodeBase64(),'UTF-8'))
    def contract = config.response
    def headers = message.getHeaders()
    String status = (headers['CamelHttpResponseCode'] ?: headers['camelhttpresponsecode'] ?: '').toString()
    if (!(status ==~ /[0-9]{3}/) || !contract.successCodes.contains(status.toInteger())) throw new IllegalStateException('SMART_HTTP_STATUS')
    String key = (headers['X-Smart-Key'] ?: '').toString()
    if (!(key ==~ /[A-Za-z0-9_.:-]{1,100}/)) throw new IllegalStateException('SMART_RESPONSE_KEY')
    String body = message.getBody(String)
    if (body.getBytes('UTF-8').length > 1024 * 1024) throw new IllegalStateException('SMART_RESPONSE_SIZE')
    if (contract.format == 'json') {
        def parsed
        try { parsed = new JsonSlurper().parseText(body) } catch (Exception ignored) { throw new IllegalStateException('SMART_RESPONSE_JSON') }
        def valueAt = { String field ->
            def current = parsed
            for (String part : field.tokenize('.')) {
                if (!(current instanceof Map) || !current.containsKey(part)) return null
                current = current[part]
            }
            return current
        }
        if (contract.requiredFields.any { valueAt(it) == null } || contract.expectedFields.any { field,value -> valueAt(field) != value }) throw new IllegalStateException('SMART_BUSINESS_RESPONSE')
    } else if (contract.format == 'xml') {
        if (body =~ /(?i)<!DOCTYPE|<!ENTITY/) throw new IllegalStateException('SMART_RESPONSE_XML')
        def f = DocumentBuilderFactory.newInstance(); f.setNamespaceAware(true)
        f.setFeature('http://apache.org/xml/features/disallow-doctype-decl',true)
        f.setFeature('http://xml.org/sax/features/external-general-entities',false)
        f.setFeature('http://xml.org/sax/features/external-parameter-entities',false)
        def doc
        try { doc = f.newDocumentBuilder().parse(new ByteArrayInputStream(body.getBytes('UTF-8'))) } catch (Exception ignored) { throw new IllegalStateException('SMART_RESPONSE_XML') }
        def xp = XPathFactory.newInstance().newXPath()
        xp.setNamespaceContext([
            getNamespaceURI:{String p -> config.namespaces[p] ?: ''},
            getPrefix:{String uri -> config.namespaces.find {k,v -> v==uri}?.key},
            getPrefixes:{String uri -> config.namespaces.findAll {k,v -> v==uri}.keySet().iterator()}
        ] as NamespaceContext)
        if (contract.requiredXmlPaths.any { !xp.evaluate(it,doc).trim() } || contract.expectedXmlValues.any { expression,value -> xp.evaluate(expression,doc) != value }) throw new IllegalStateException('SMART_BUSINESS_RESPONSE')
    } else if (!contract.bodyContains || !body.contains(contract.bodyContains)) {
        throw new IllegalStateException('SMART_BUSINESS_RESPONSE')
    }
    def out = new StringWriter()
    new MarkupBuilder(out).Result(key:key,ok:'true',httpStatus:status)
    message.setBody(out.toString())
    // The result envelope intentionally excludes request and response business payloads.
    return message
}
