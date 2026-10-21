import com.sap.gateway.ip.core.customdev.util.Message
import java.time.LocalDate
import groovy.xml.MarkupBuilder
import groovy.json.JsonSlurper

Message processData(Message message) {
    List<Map> rows = message.getProperty('poRows') as List<Map>
    if (!rows) throw new IllegalArgumentException('PO_NO_ROWS')
    List<String> required = ['OrderRef','CompanyCode','DocType','Vendor','PurchOrg','PurchGroup','Currency','ItemNo','Material','Plant','Quantity','Unit','NetPrice','PriceUnit','DeliveryDate']
    Map<String, List<Map>> orders = [:]
    Set<String> itemKeys = [] as Set
    rows.each { row ->
        if (required.any { !row[it]?.toString()?.trim() }) throw new IllegalArgumentException('PO_REQUIRED_FIELD row=' + row._row)
        if (!(row.CompanyCode ==~ /[0-9]{4}/) || !(row.PurchOrg ==~ /[A-Z0-9]{4}/) || !(row.PurchGroup ==~ /[A-Z0-9]{3}/) || !(row.Plant ==~ /[A-Z0-9]{4}/)) throw new IllegalArgumentException('PO_ORG_FORMAT row=' + row._row)
        if (!(row.Vendor ==~ /[0-9]{10}/) || !(row.Material ==~ /[A-Za-z0-9_.-]{1,18}/)) throw new IllegalArgumentException('PO_IDENTIFIER_FORMAT row=' + row._row)
        if (!(row.OrderRef ==~ /[A-Za-z0-9_.-]{1,35}/) || !(row.Currency ==~ /[A-Z]{3}/) || !(row.Unit ==~ /[A-Z0-9]{1,3}/) || !(row.DocType ==~ /[A-Z0-9]{2,4}/)) throw new IllegalArgumentException('PO_HEADER_FORMAT row=' + row._row)
        ['Quantity','NetPrice','PriceUnit'].each { field ->
            String raw = row[field]
            if (!(raw ==~ /-?[0-9]+(?:\.[0-9]+)?/) || raw.length() > 18) throw new IllegalArgumentException('PO_NUMBER_FORMAT field=' + field)
            BigDecimal amount = new BigDecimal(raw)
            int maxScale = field == 'Quantity' ? 3 : field == 'NetPrice' ? 4 : 0
            if (amount <= 0 || amount > new BigDecimal('9999999999') || amount.stripTrailingZeros().scale() > maxScale) throw new IllegalArgumentException('PO_NUMBER_RANGE field=' + field)
            row[field] = amount.stripTrailingZeros().toPlainString()
        }
        if (!(row.ItemNo ==~ /[0-9]{1,5}/) || row.ItemNo.toInteger() == 0) throw new IllegalArgumentException('PO_ITEM_NUMBER')
        row.ItemNo = row.ItemNo.padLeft(5,'0')
        if (!itemKeys.add(row.OrderRef + ':' + row.ItemNo)) throw new IllegalArgumentException('PO_DUPLICATE_ITEM')
        if (!(row.DeliveryDate ==~ /[0-9]{4}-[0-9]{2}-[0-9]{2}/)) throw new IllegalArgumentException('PO_DELIVERY_DATE')
        try { LocalDate.parse(row.DeliveryDate) } catch (Exception ignored) { throw new IllegalArgumentException('PO_DELIVERY_DATE') }
        List<Map> existing = orders[row.OrderRef] ?: []
        if (existing && ['CompanyCode','DocType','Vendor','PurchOrg','PurchGroup','Currency'].any { row[it] != existing[0][it] }) throw new IllegalArgumentException('PO_INCONSISTENT_HEADER')
        existing << row
        orders[row.OrderRef] = existing
    }
    // Synthetic master data only. Never claim these are ERP existence checks.
    def master = new JsonSlurper().parseText(message.getProperty('fixtureMasterData') as String)
    (message.getProperty('poRows') as List<Map>).each { row ->
        def vendor = master.vendors[row.Vendor]
        def material = master.materials[row.Material]
        if (!vendor || !vendor.companyCodes.contains(row.CompanyCode) || !vendor.purchOrgs.contains(row.PurchOrg)) throw new IllegalArgumentException('MASTER_VENDOR_NOT_ALLOWED')
        if (!master.plants.contains(row.Plant)) throw new IllegalArgumentException('MASTER_PLANT_NOT_FOUND')
        if (!material || !material.plants.contains(row.Plant)) throw new IllegalArgumentException('MASTER_MATERIAL_PLANT_NOT_FOUND')
        if (!material.units.contains(row.Unit)) throw new IllegalArgumentException('MASTER_UNIT_NOT_ALLOWED')
        if (!master.currencies.contains(row.Currency)) throw new IllegalArgumentException('MASTER_CURRENCY_NOT_ALLOWED')
    }
    message.setProperty('masterValidationMode','SYNTHETIC_FIXTURE')

    message.setProperty('poOrders', orders)
    message.setProperty('poCount', orders.size())
    message.setProperty('itemCount', rows.size())
    def normalized = new StringWriter()
    def xml = new MarkupBuilder(normalized)
    xml.PurchaseOrders {
        orders.each { reference, lines ->
            PurchaseOrder(reference:reference) {
                Header {
                    ['CompanyCode','DocType','Vendor','PurchOrg','PurchGroup','Currency'].each { key -> "$key"(lines[0][key]) }
                }
                Items {
                    lines.each { line ->
                        Item {
                            ['ItemNo','Material','Plant','Quantity','Unit','NetPrice','PriceUnit','DeliveryDate'].each { key -> "$key"(line[key]) }
                        }
                    }
                }
            }
        }
    }
    message.setProperty('canonicalXml', normalized.toString())
    message.setBody(normalized.toString())
    return message
}
