package com.sap.gateway.ip.core.customdev.util

// Local harness stub only. This file is never bundled into CPI.
class Message {
    private Object body
    private Map properties=[:]
    private Map headers=[:]
    def getBody(Class type) {
        if(type==byte[].class) return body instanceof byte[] ? body : body.toString().getBytes('UTF-8')
        if(type==String) return body instanceof byte[] ? new String(body,'UTF-8') : body.toString()
        return body
    }
    void setBody(Object value) { body=value }
    Object getProperty(String key) { properties[key] }
    void setProperty(String key,Object value) { properties[key]=value }
    Map getProperties() { properties }
    void setHeader(String key,Object value) { headers[key]=value }
    Map getHeaders() { headers }
}
