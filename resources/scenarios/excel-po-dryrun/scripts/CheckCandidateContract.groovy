import com.sap.gateway.ip.core.customdev.util.Message
import groovy.util.XmlSlurper

Message processData(Message message) {
    String body = message.getBody(String)
    if (body =~ /(?i)<!DOCTYPE|<!ENTITY/) throw new IllegalArgumentException('IDOC_DTD')
    def parser = new XmlSlurper(false,true)
    parser.setFeature('http://apache.org/xml/features/disallow-doctype-decl',true)
    def batch = parser.parseText(body)
    if (batch.name() != 'DryRunIdocBatch' || batch.@status.text() != 'NOT_POSTED' || batch.Order.size() != message.getProperty('poCount')) throw new IllegalStateException('IDOC_BATCH_CONTRACT')
    int items = 0
    batch.Order.each { order ->
        def idoc = order.PORDCR103.IDOC
        if (idoc.size() != 1 || idoc.@BEGIN.text() != '1' || idoc.EDI_DC40.MESTYP.text() != 'PORDCR1' || idoc.EDI_DC40.IDOCTYP.text() != 'PORDCR103' || idoc.EDI_DC40.DIRECT.text() != '2') throw new IllegalStateException('IDOC_CONTROL_CONTRACT')
        def root = idoc.E1PORDCR1
        if (root.TESTRUN.text() != 'X' || root.E1BPMEPOHEADER.size() != 1 || root.E1BPMEPOHEADERX.size() != 1) throw new IllegalStateException('IDOC_HEADER_CONTRACT')
        def lines = (message.getProperty('poOrders') as Map)[order.@reference.text()]
        if (!lines || root.E1BPMEPOITEM.size() != lines.size() || root.E1BPMEPOITEMX.size() != lines.size() || root.E1BPMEPOSCHEDULE.size() != lines.size() || root.E1BPMEPOSCHEDULX.size() != lines.size()) throw new IllegalStateException('IDOC_ITEM_COUNT')
        root.E1BPMEPOITEM.eachWithIndex { item, i ->
            def line = lines[i]
            if (item.PO_ITEM.text() != line.ItemNo || item.MATERIAL.text() != line.Material || item.PLANT.text() != line.Plant || item.QUANTITY.text() != line.Quantity || item.NET_PRICE.text() != line.NetPrice || item.PO_UNIT.text() != line.Unit || item.PRICE_UNIT.text() != line.PriceUnit) throw new IllegalStateException('IDOC_MAPPING_MISMATCH')
            def flags = root.E1BPMEPOITEMX[i]
            if (flags.PO_ITEM.text() != line.ItemNo || flags.MATERIAL.text() != 'X' || flags.QUANTITY.text() != 'X' || flags.NET_PRICE.text() != 'X') throw new IllegalStateException('IDOC_ITEM_FLAGS')
            def schedule = root.E1BPMEPOSCHEDULE[i]
            if (schedule.PO_ITEM.text() != line.ItemNo || schedule.DELIVERY_DATE.text() != line.DeliveryDate.replace('-','') || schedule.QUANTITY.text() != line.Quantity) throw new IllegalStateException('IDOC_SCHEDULE_MISMATCH')
            items++
        }
    }
    if (items != message.getProperty('itemCount')) throw new IllegalStateException('IDOC_TOTAL_COUNT')
    message.setProperty('candidateContractChecked',true)
    return message
}
