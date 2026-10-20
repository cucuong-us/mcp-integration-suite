import com.sap.gateway.ip.core.customdev.util.Message

Message processData(Message message) {
    if (message.getProperty('dryRun') != true || message.getProperty('candidateContractChecked') != true) throw new IllegalStateException('DRY_RUN_GUARD')
    message.setProperty('externalCalls',0)
    message.setProperty('deliveryStatus','NOT_POSTED')
    message.setProperty('backendPoCreated',false)
    return message
}
