import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurper

Message processData(Message message) {
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
    return message
}
