import com.sap.gateway.ip.core.customdev.util.Message

Message processData(Message message) {
    if (message.getProperty('deliveryStatus') != 'NOT_POSTED' || message.getProperty('externalCalls') != 0 || message.getProperty('backendPoCreated') != false || message.getProperty('idocSchemaVerified') != false) throw new IllegalStateException('DRY_RUN_EVIDENCE_GUARD')
    def log = messageLogFactory.getMessageLog(message)
    if (log != null) {
        log.addCustomHeaderProperty('DryRunResult','CANDIDATE_VALIDATED_NOT_POSTED')
        log.addCustomHeaderProperty('DryRunOrderCount',message.getProperty('poCount').toString())
        log.addCustomHeaderProperty('DryRunItemCount',message.getProperty('itemCount').toString())
        log.addCustomHeaderProperty('DryRunExternalCalls','0')
        log.addCustomHeaderProperty('DryRunMasterData','SYNTHETIC_FIXTURE')
        log.addCustomHeaderProperty('DryRunSchemaVerified','false')
        log.addCustomHeaderProperty('DryRunCase',message.getProperty('dryRunCase').toString())
    }
    // Never attach the workbook or IDoc body to MPL.
    return message
}
