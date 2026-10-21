import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import groovy.util.XmlSlurper
import javax.xml.XMLConstants
import javax.xml.transform.TransformerFactory
import javax.xml.transform.stream.StreamSource
import javax.xml.transform.stream.StreamResult
import javax.xml.validation.SchemaFactory

// Runs the exact CPI script sources with a Message stub, not a JS reimplementation.
def root=new File(args[0])
def fixtures=new File(args[1])
def output=new File(args[2]);output.mkdirs()
def loader=new GroovyClassLoader(this.class.classLoader)
Class messageClass=loader.parseClass(new File(root,'tests/Message.groovy'))
def blueprint=new JsonSlurper().parse(new File(args[3]))
def classes=blueprint.nodes.findAll { it.type=='groovy' }.collectEntries { [(it.properties.script):loader.parseClass(new File(root,'scripts/'+it.properties.script))] }
def resource={ String name -> new File(root,name) }
def validateXml={ String body,String xsd ->
    def factory=SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI)
    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD,'')
    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA,'')
    factory.newSchema(resource(xsd)).newValidator().validate(new StreamSource(new StringReader(body)))
}
def transformerFactory=TransformerFactory.newInstance()
transformerFactory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING,true)
transformerFactory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD,'')
transformerFactory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET,'')
def mapping=transformerFactory.newTemplates(new StreamSource(resource('mapping/MapCandidateIdocs.xsl')))
def errorClass=loader.parseClass(new File(root,'scripts/RecordDryRunFailure.groovy'))
def matrix=new JsonSlurper().parse(new File(fixtures,'cases.json'))
def results=[]
def componentChecks=[]
matrix.each { tc ->
    def message=messageClass.newInstance()
    byte[] bytes=new File(fixtures,tc.file as String).bytes
    message.setBody(bytes);message.setProperty('dryRun',true);message.setProperty('dryRunCase',tc.id)
    message.setProperty('fixtureMasterData',new File(root,'fixtures/master-data.json').getText('UTF-8'))
    Map logProperties=[:]
    def log=[addCustomHeaderProperty:{String key,String value -> logProperties[key]=value}]
    def factory=[getMessageLog:{Object ignored -> log}]
    String failure=null
    try {
        blueprint.nodes.each { node ->
            def props=node.properties ?: [:]
            switch(node.type) {
                case 'contentModifier':
                    if(node.id=='CallActivity_LoadFixture') message.setBody(bytes.encodeBase64().toString())
                    else if(props.wrapContent!='${in.body}') throw new IllegalStateException('Unsupported harness content modifier')
                    def table=new XmlSlurper().parseText('<table>'+props.propertyTable+'</table>')
                    table.row.each { row ->
                        def cells=row.cell.collectEntries { [(it.@id.text()):it.text()] }
                        assert cells.Type=='constant'
                        message.setProperty(cells.Name,cells.Name=='dryRunCase' ? tc.id : cells.Value)
                    }
                    break
                case 'groovy':
                    def script=classes[props.script].newInstance()
                    script.setBinding(new Binding([messageLogFactory:factory]));script.processData(message)
                    break
                case 'xmlValidator':
                    validateXml(message.getBody(String),props.xsd.substring(1));break
                case 'xsltMapping':
                    def out=new StringWriter()
                    mapping.newTransformer().transform(new StreamSource(new StringReader(message.getBody(String))),new StreamResult(out))
                    message.setBody(out.toString());break
                case 'start':case 'end':break
                default:throw new IllegalStateException('Unsupported harness component: '+node.type)
            }
        }
    }
    catch(Exception e) {
        failure=e.message ?: e.class.name
        message.setProperty('CamelExceptionCaught',e)
        def handler=errorClass.newInstance();handler.setBinding(new Binding([messageLogFactory:factory]));assert handler.processData(message).is(message)
    }
    boolean passed
    if(tc.expectedError) passed=failure!=null && failure.contains(tc.expectedError as String) && logProperties.DryRunResult=='REJECTED_OR_FAILED' && logProperties.DryRunErrorCode==tc.expectedError
    else {
        passed=failure==null && message.getProperty('poCount')==tc.orders && message.getProperty('itemCount')==tc.items && logProperties.DryRunResult=='CANDIDATE_VALIDATED_NOT_POSTED' && message.getProperty('externalCalls')=='0' && message.getProperty('backendPoCreated')=='false'
        if(passed) {
            def xml=new XmlSlurper().parseText(message.getBody(String))
            def first=xml.Order[0].PORDCR103.IDOC.E1PORDCR1
            assert first.E1BPMEPOHEADER.VENDOR.text()=='0000100001'
            assert first.E1BPMEPOITEM[0].PO_ITEM.text()=='00010'
            assert first.E1BPMEPOITEM[0].QUANTITY.text()=='12'
            assert first.E1BPMEPOITEM[0].NET_PRICE.text()=='25.5'
            assert first.E1BPMEPOSCHEDULE[0].DELIVERY_DATE.text()=='20261101'
            if(tc.id=='valid') {
                new File(output,'candidate-idocs.xml').setText(message.getBody(String),'UTF-8')
                new File(output,'normalized-purchase-orders.xml').setText(message.getProperty('canonicalXml') as String,'UTF-8')
                String candidate=message.getBody(String)
                def probes=[
                    [id:'canonical-schema-rejects-missing-vendor',schema:'xsd/PurchaseOrders.xsd',body:(message.getProperty('canonicalXml') as String).replaceAll(/<Vendor>[^<]*<\/Vendor>/,'')],
                    [id:'candidate-schema-rejects-missing-vendor',schema:'xsd/DryRunIdocBatch.xsd',body:candidate.replaceAll(/<VENDOR>[^<]*<\/VENDOR>/,'')],
                    [id:'candidate-schema-rejects-false-certification',schema:'xsd/DryRunIdocBatch.xsd',body:candidate.replace('schemaVerified="false"','schemaVerified="true"')],
                    [id:'audit-rejects-quantity-corruption',error:'IDOC_MAPPING_MISMATCH',body:candidate.replaceFirst('<QUANTITY>12</QUANTITY>','<QUANTITY>99</QUANTITY>')],
                    [id:'audit-rejects-schedule-corruption',error:'IDOC_SCHEDULE_MISMATCH',body:candidate.replaceFirst('<DELIVERY_DATE>20261101</DELIVERY_DATE>','<DELIVERY_DATE>20261201</DELIVERY_DATE>')],
                    [id:'audit-rejects-disabled-dryrun',error:'DRY_RUN_GUARD',body:candidate,dryRun:'false']
                ]
                probes.each { probe ->
                    def altered=messageClass.newInstance()
                    message.getProperties().each { k,v -> altered.setProperty(k,v) }
                    altered.setBody(probe.body)
                    if(probe.dryRun) altered.setProperty('dryRun',probe.dryRun)
                    String rejected=null
                    try {
                        if(probe.schema) validateXml(probe.body,probe.schema)
                        else {
                            // These mutations remain schema-valid: semantic integrity must still be checked.
                            validateXml(probe.body,'xsd/DryRunIdocBatch.xsd')
                            def audit=classes['AuditDryRun.groovy'].newInstance()
                            audit.setBinding(new Binding([messageLogFactory:factory]));audit.processData(altered)
                        }
                    } catch(Exception e) { rejected=e.message ?: e.class.name }
                    boolean rejectedCorrectly=rejected!=null && (!probe.error || rejected.contains(probe.error))
                    componentChecks << [id:probe.id,passed:rejectedCorrectly]
                    assert rejectedCorrectly : 'Native component/guard regression: '+probe.id
                }
            }
        }
    }
    results << [id:tc.id,passed:passed,expectedError:tc.expectedError,actualError:failure,orders:message.getProperty('poCount'),items:message.getProperty('itemCount'),externalCalls:message.getProperty('externalCalls') ?: 0]
    println JsonOutput.toJson(results[-1])
}
def report=[runtime:'Java '+System.getProperty('java.version')+' / Groovy '+GroovySystem.version,passed:results.count {it.passed},total:results.size(),componentChecks:componentChecks,backendPoCreated:false,backendSchemaVerified:false,cases:results]
new File(output,'offline-report.json').setText(JsonOutput.prettyPrint(JsonOutput.toJson(report)),'UTF-8')
assert results.every { it.passed } : 'Dry-run regression failed; inspect offline-report.json'
