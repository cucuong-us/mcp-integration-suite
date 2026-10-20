import com.sap.gateway.ip.core.customdev.util.Message
import groovy.xml.MarkupBuilder

Message processData(Message message) {
    if (message.getProperty('masterValidationMode') != 'SYNTHETIC_FIXTURE') throw new IllegalStateException('MASTER_VALIDATION_REQUIRED')
    def out = new StringWriter()
    def xml = new MarkupBuilder(out)
    // Candidate PORDCR103 shape: a backend-exported XSD is still required.
    xml.DryRunIdocBatch(status:'NOT_POSTED', schemaVerified:'false') {
        (message.getProperty('poOrders') as Map).each { orderRef, lines ->
            Order(reference:orderRef) {
                PORDCR103 {
                    IDOC(BEGIN:'1') {
                        EDI_DC40(SEGMENT:'1') {
                            TABNAM('EDI_DC40'); DIRECT('2'); IDOCTYP('PORDCR103'); MESTYP('PORDCR1')
                            SNDPOR('CPI_DRYRUN'); SNDPRT('LS'); SNDPRN('CPI_DRYRUN')
                            RCVPOR('ERP_DRYRUN'); RCVPRT('LS'); RCVPRN('ERP_DRYRUN')
                        }
                        E1PORDCR1(SEGMENT:'1') {
                            TESTRUN('X')
                            def header = lines[0]
                            E1BPMEPOHEADER(SEGMENT:'1') {
                                COMP_CODE(header.CompanyCode); DOC_TYPE(header.DocType); VENDOR(header.Vendor)
                                PURCH_ORG(header.PurchOrg); PUR_GROUP(header.PurchGroup); CURRENCY(header.Currency)
                            }
                            E1BPMEPOHEADERX(SEGMENT:'1') {
                                COMP_CODE('X'); DOC_TYPE('X'); VENDOR('X'); PURCH_ORG('X'); PUR_GROUP('X'); CURRENCY('X')
                            }
                            lines.each { line ->
                                E1BPMEPOITEM(SEGMENT:'1') {
                                    PO_ITEM(line.ItemNo); MATERIAL(line.Material); PLANT(line.Plant); QUANTITY(line.Quantity)
                                    PO_UNIT(line.Unit); NET_PRICE(line.NetPrice); PRICE_UNIT(line.PriceUnit)
                                }
                                E1BPMEPOITEMX(SEGMENT:'1') {
                                    PO_ITEM(line.ItemNo); PO_ITEMX('X'); MATERIAL('X'); PLANT('X'); QUANTITY('X'); PO_UNIT('X'); NET_PRICE('X'); PRICE_UNIT('X')
                                }
                                E1BPMEPOSCHEDULE(SEGMENT:'1') {
                                    PO_ITEM(line.ItemNo); SCHED_LINE('0001'); DELIVERY_DATE(line.DeliveryDate.replace('-','')); QUANTITY(line.Quantity)
                                }
                                E1BPMEPOSCHEDULX(SEGMENT:'1') {
                                    PO_ITEM(line.ItemNo); SCHED_LINE('0001'); PO_ITEMX('X'); SCHED_LINEX('X'); DELIVERY_DATE('X'); QUANTITY('X')
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    message.setBody(out.toString())
    message.setHeader('Content-Type','application/xml')
    message.setProperty('idocSchemaVerified',false)
    return message
}
