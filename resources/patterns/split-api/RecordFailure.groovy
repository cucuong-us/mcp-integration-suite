import com.sap.gateway.ip.core.customdev.util.Message

Message processData(Message message) {
    String failure = (message.getProperty('CamelExceptionCaught') ?: '').toString()
    def match = failure =~ /\bSMART_[A-Z_]+\b/
    String code = match.find() ? match.group() : 'SMART_UPSTREAM_FAILURE'
    def log = messageLogFactory.getMessageLog(message)
    if (log != null) {
        log.addCustomHeaderProperty('SmartResult','FAILED')
        log.addCustomHeaderProperty('SmartErrorCode',code)
        log.addCustomHeaderProperty('SmartCase',(message.getProperty('SmartCase') ?: 'unspecified').toString())
    }
    // Already processed records can have committed side effects. Do not replay the batch.
    return message
}
