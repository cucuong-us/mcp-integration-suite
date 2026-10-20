import com.sap.gateway.ip.core.customdev.util.Message

Message processData(Message message) {
    String failure = (message.getProperty('CamelExceptionCaught') ?: '').toString()
    def match = failure =~ /\b(?:XLSX_[A-Z_]+|PO_[A-Z_]+|MASTER_[A-Z_]+|IDOC_[A-Z_]+)\b/
    String code = match.find() ? match.group() : 'UNEXPECTED'
    def log = messageLogFactory.getMessageLog(message)
    if (log != null) {
        log.addCustomHeaderProperty('DryRunResult','REJECTED_OR_FAILED')
        log.addCustomHeaderProperty('DryRunExternalCalls','0')
        log.addCustomHeaderProperty('DryRunCase',(message.getProperty('dryRunCase') ?: 'unknown').toString())
        log.addCustomHeaderProperty('DryRunErrorCode',code)
    }
    // Return normally so logging completes; the subsequent Error End preserves FAILED.
    return message
}
