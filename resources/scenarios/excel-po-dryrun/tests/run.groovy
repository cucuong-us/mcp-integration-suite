import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import groovy.util.XmlSlurper

// Runs the exact CPI script sources with a Message stub, not a JS reimplementation.
def root=new File(args[0])
def fixtures=new File(args[1])
def output=new File(args[2]);output.mkdirs()
def loader=new GroovyClassLoader(this.class.classLoader)
Class messageClass=loader.parseClass(new File(root,'tests/Message.groovy'))
def stages=['ReadPurchaseOrderXlsx','ValidatePurchaseOrders','ValidateFixtureMasterData','MapCandidateIdocs','CheckCandidateContract','SimulateDelivery','RecordDryRunEvidence']
def classes=stages.collect { loader.parseClass(new File(root,'scripts/'+it+'.groovy')) }
def errorClass=loader.parseClass(new File(root,'scripts/RecordDryRunFailure.groovy'))
def matrix=new JsonSlurper().parse(new File(fixtures,'cases.json'))
def results=[]
matrix.each { tc ->
    def message=messageClass.newInstance()
    byte[] bytes=new File(fixtures,tc.file as String).bytes
    message.setBody(bytes);message.setProperty('dryRun',true);message.setProperty('dryRunCase',tc.id)
    message.setProperty('fixtureMasterData',new File(root,'fixtures/master-data.json').getText('UTF-8'))
    Map logProperties=[:]
    def log=[addCustomHeaderProperty:{String key,String value -> logProperties[key]=value}]
    def factory=[getMessageLog:{Object ignored -> log}]
    String failure=null
    try { classes.each { klass -> def script=klass.newInstance();script.setBinding(new Binding([messageLogFactory:factory]));script.processData(message) } }
    catch(Exception e) {
        failure=e.message ?: e.class.name
        message.setProperty('CamelExceptionCaught',e)
        def handler=errorClass.newInstance();handler.setBinding(new Binding([messageLogFactory:factory]));assert handler.processData(message).is(message)
    }
    boolean passed
    if(tc.expectedError) passed=failure!=null && failure.contains(tc.expectedError as String) && logProperties.DryRunResult=='REJECTED_OR_FAILED' && logProperties.DryRunErrorCode==tc.expectedError
    else {
        passed=failure==null && message.getProperty('poCount')==tc.orders && message.getProperty('itemCount')==tc.items && logProperties.DryRunResult=='CANDIDATE_VALIDATED_NOT_POSTED' && message.getProperty('externalCalls')==0 && message.getProperty('backendPoCreated')==false
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
            }
        }
    }
    results << [id:tc.id,passed:passed,expectedError:tc.expectedError,actualError:failure,orders:message.getProperty('poCount'),items:message.getProperty('itemCount'),externalCalls:message.getProperty('externalCalls') ?: 0]
    println JsonOutput.toJson(results[-1])
}
def report=[runtime:'Java '+System.getProperty('java.version')+' / Groovy '+GroovySystem.version,passed:results.count {it.passed},total:results.size(),backendPoCreated:false,backendSchemaVerified:false,cases:results]
new File(output,'offline-report.json').setText(JsonOutput.prettyPrint(JsonOutput.toJson(report)),'UTF-8')
assert results.every { it.passed } : 'Dry-run regression failed; inspect offline-report.json'
