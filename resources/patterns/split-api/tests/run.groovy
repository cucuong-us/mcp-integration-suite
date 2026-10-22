import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.xpath.XPathFactory
import javax.xml.xpath.XPathConstants
import javax.xml.transform.TransformerFactory
import javax.xml.transform.stream.StreamSource
import javax.xml.transform.stream.StreamResult
import javax.xml.transform.dom.DOMSource

def repo=new File(args[0]),cases=new JsonSlurper().parse(new File(args[1]))
def loader=new GroovyClassLoader(this.class.classLoader)
def messageClass=loader.parseClass(new File(repo,'resources/scenarios/excel-po-dryrun/tests/Message.groovy'))
def parseXml={ String text ->
 def f=DocumentBuilderFactory.newInstance();f.setNamespaceAware(true)
 f.setFeature('http://apache.org/xml/features/disallow-doctype-decl',true)
 f.newDocumentBuilder().parse(new ByteArrayInputStream(text.getBytes('UTF-8')))
}
def serialize={ node -> def out=new StringWriter();TransformerFactory.newInstance().newTransformer().transform(new DOMSource(node),new StreamResult(out));out.toString() }
def results=[]
cases.each { tc ->
 def bp=tc.blueprint,classes=[:],logs=[:]
 bp.resources.findAll {it.path.endsWith('.groovy')}.each { r -> classes[r.path.tokenize('/')[-1]]=loader.parseClass(r.content,r.path.tokenize('/')[-1]) }
 def factory=[getMessageLog:{msg -> [addCustomHeaderProperty:{String key,String value -> logs[key]=value}]}]
 def execute={String name,msg -> def script=classes[name].newInstance();script.setBinding(new Binding([messageLogFactory:factory]));script.processData(msg)}
 def message=messageClass.newInstance();message.setBody(tc.body);message.setProperty('SmartCase',tc.id)
 String failure=null
 try {
  execute('SmartGuardBatch.groovy',message)
  def original=parseXml(tc.body),xp=XPathFactory.newInstance().newXPath()
  def xpath=bp.nodes.find {it.type=='generalSplitter'}.splitter.xpath
  def count=xp.evaluate(xpath,original,XPathConstants.NODESET).length
  def bodies=[]
  for(int i=0;i<count;i++) {
   // Model only this General Splitter subset, retaining ancestors for the real XSLT.
   def splitDoc=original.cloneNode(true),recordNodes=xp.evaluate(xpath,splitDoc,XPathConstants.NODESET)
   for(int j=recordNodes.length-1;j>=0;j--) if(j!=i) recordNodes.item(j).parentNode.removeChild(recordNodes.item(j))
   def part=messageClass.newInstance();message.getProperties().each {k,v -> part.setProperty(k,v)};part.setBody(serialize(splitDoc))
   def worker=bp.localProcesses[0]
   def modifier=worker.nodes.find {it.id=='WorkerHeaders'}
   def table=new XmlSlurper().parseText('<table>'+modifier.properties.headerTable+'</table>')
   table.row.each { row ->
    def cells=row.cell.collectEntries {[(it.@id.text()):it.text()]}
    String value=cells.Type=='xpath'?xp.evaluate(cells.Value,splitDoc):cells.Type=='expression'?message.getProperty('SmartBatchId'):cells.Value
    part.setHeader(cells.Name,value)
   }
   def mapping=bp.resources.find {it.path.endsWith('.xsl')}
   def out=new StringWriter()
   TransformerFactory.newInstance().newTransformer(new StreamSource(new StringReader(mapping.content))).transform(new DOMSource(splitDoc),new StreamResult(out))
   part.setBody(out.toString())
   def connection=new URL(tc.mockUrl).openConnection()
   connection.requestMethod='POST';connection.connectTimeout=3000;connection.readTimeout=tc.id=='timeout-no-replay'?50:3000
   part.getHeaders().each {k,v -> connection.setRequestProperty(k,v.toString())}
   connection.doOutput=true
   try {
    connection.outputStream.withCloseable {it.write(part.getBody(String).getBytes('UTF-8'))}
    int status=connection.responseCode
    if(status>=300)throw new IllegalStateException('SMART_HTTP_FAILURE')
    part.setHeader('CamelHttpResponseCode',status)
    part.setBody(connection.inputStream.getText('UTF-8'))
   } catch(java.net.SocketTimeoutException ignored) { throw new IllegalStateException('SMART_HTTP_TIMEOUT') }
   finally {connection.disconnect()}
   execute('SmartGuardResponse.groovy',part)
   bodies<<part.getBody(String)
  }
  if(tc.mutation=='drop')bodies.remove(bodies.size()-1)
  if(tc.mutation=='duplicate')bodies[1]=bodies[0]
  if(tc.mutation=='foreign')bodies[1]=bodies[1].replace('PO-B','UNKNOWN')
  message.setBody('<multimap:Messages xmlns:multimap="http://sap.com/xi/XI/SplitAndMerge"><multimap:Message1>'+bodies.join('')+'</multimap:Message1></multimap:Messages>')
  execute('SmartAuditBatch.groovy',message)
 } catch(Exception e) {
  failure=e.message ?: e.class.name
  message.setProperty('CamelExceptionCaught',e)
  execute('SmartRecordFailure.groovy',message)
 }
 boolean passed=tc.error?failure?.contains(tc.error) && logs.SmartResult=='FAILED':failure==null && logs.SmartResult=='COMPLETE' && logs.SmartRecordCount=='2'
 results<<[id:tc.id,passed:passed,expectedError:tc.error,actualError:failure,metadata:logs]
 println JsonOutput.toJson(results[-1])
}
new File(args[2]).setText(JsonOutput.prettyPrint(JsonOutput.toJson([cases:results,passed:results.every {it.passed}])),'UTF-8')
assert results.every {it.passed} : 'Pattern regression failed'
