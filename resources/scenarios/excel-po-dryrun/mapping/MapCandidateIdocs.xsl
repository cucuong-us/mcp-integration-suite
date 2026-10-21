<?xml version="1.0" encoding="UTF-8"?>
<!-- Dry-run candidate contract only. Not a backend-exported SAP IDoc schema. -->
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0">
  <xsl:output method="xml" encoding="UTF-8" omit-xml-declaration="yes"/>
  <xsl:template match="/PurchaseOrders">
    <DryRunIdocBatch status="NOT_POSTED" schemaVerified="false">
      <xsl:for-each select="PurchaseOrder">
        <Order reference="{@reference}">
          <PORDCR103>
            <IDOC BEGIN="1">
              <EDI_DC40 SEGMENT="1">
                <TABNAM>EDI_DC40</TABNAM>
                <DIRECT>2</DIRECT>
                <IDOCTYP>PORDCR103</IDOCTYP>
                <MESTYP>PORDCR1</MESTYP>
                <SNDPOR>CPI_DRYRUN</SNDPOR>
                <SNDPRT>LS</SNDPRT>
                <SNDPRN>CPI_DRYRUN</SNDPRN>
                <RCVPOR>ERP_DRYRUN</RCVPOR>
                <RCVPRT>LS</RCVPRT>
                <RCVPRN>ERP_DRYRUN</RCVPRN>
              </EDI_DC40>
              <E1PORDCR1 SEGMENT="1">
                <TESTRUN>X</TESTRUN>
                <E1BPMEPOHEADER SEGMENT="1">
                  <COMP_CODE>
                    <xsl:value-of select="Header/CompanyCode"/>
                  </COMP_CODE>
                  <DOC_TYPE>
                    <xsl:value-of select="Header/DocType"/>
                  </DOC_TYPE>
                  <VENDOR>
                    <xsl:value-of select="Header/Vendor"/>
                  </VENDOR>
                  <PURCH_ORG>
                    <xsl:value-of select="Header/PurchOrg"/>
                  </PURCH_ORG>
                  <PUR_GROUP>
                    <xsl:value-of select="Header/PurchGroup"/>
                  </PUR_GROUP>
                  <CURRENCY>
                    <xsl:value-of select="Header/Currency"/>
                  </CURRENCY>
                </E1BPMEPOHEADER>
                <E1BPMEPOHEADERX SEGMENT="1">
                  <COMP_CODE>X</COMP_CODE>
                  <DOC_TYPE>X</DOC_TYPE>
                  <VENDOR>X</VENDOR>
                  <PURCH_ORG>X</PURCH_ORG>
                  <PUR_GROUP>X</PUR_GROUP>
                  <CURRENCY>X</CURRENCY>
                </E1BPMEPOHEADERX>
                <xsl:for-each select="Items/Item">
                  <E1BPMEPOITEM SEGMENT="1">
                    <PO_ITEM>
                      <xsl:value-of select="ItemNo"/>
                    </PO_ITEM>
                    <MATERIAL>
                      <xsl:value-of select="Material"/>
                    </MATERIAL>
                    <PLANT>
                      <xsl:value-of select="Plant"/>
                    </PLANT>
                    <QUANTITY>
                      <xsl:value-of select="Quantity"/>
                    </QUANTITY>
                    <PO_UNIT>
                      <xsl:value-of select="Unit"/>
                    </PO_UNIT>
                    <NET_PRICE>
                      <xsl:value-of select="NetPrice"/>
                    </NET_PRICE>
                    <PRICE_UNIT>
                      <xsl:value-of select="PriceUnit"/>
                    </PRICE_UNIT>
                  </E1BPMEPOITEM>
                  <E1BPMEPOITEMX SEGMENT="1">
                    <PO_ITEM>
                      <xsl:value-of select="ItemNo"/>
                    </PO_ITEM>
                    <PO_ITEMX>X</PO_ITEMX>
                    <MATERIAL>X</MATERIAL>
                    <PLANT>X</PLANT>
                    <QUANTITY>X</QUANTITY>
                    <PO_UNIT>X</PO_UNIT>
                    <NET_PRICE>X</NET_PRICE>
                    <PRICE_UNIT>X</PRICE_UNIT>
                  </E1BPMEPOITEMX>
                  <E1BPMEPOSCHEDULE SEGMENT="1">
                    <PO_ITEM>
                      <xsl:value-of select="ItemNo"/>
                    </PO_ITEM>
                    <SCHED_LINE>0001</SCHED_LINE>
                    <DELIVERY_DATE>
                      <xsl:value-of select="translate(DeliveryDate,'-','')"/>
                    </DELIVERY_DATE>
                    <QUANTITY>
                      <xsl:value-of select="Quantity"/>
                    </QUANTITY>
                  </E1BPMEPOSCHEDULE>
                  <E1BPMEPOSCHEDULX SEGMENT="1">
                    <PO_ITEM>
                      <xsl:value-of select="ItemNo"/>
                    </PO_ITEM>
                    <SCHED_LINE>0001</SCHED_LINE>
                    <PO_ITEMX>X</PO_ITEMX>
                    <SCHED_LINEX>X</SCHED_LINEX>
                    <DELIVERY_DATE>X</DELIVERY_DATE>
                    <QUANTITY>X</QUANTITY>
                  </E1BPMEPOSCHEDULX>
                </xsl:for-each>
              </E1PORDCR1>
            </IDOC>
          </PORDCR103>
        </Order>
      </xsl:for-each>
    </DryRunIdocBatch>
  </xsl:template>
</xsl:stylesheet>
