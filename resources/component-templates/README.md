# Extended component metadata

`extended.json` contains property-only templates extracted from exported iFlow components, with sample destinations, queue names, credential aliases and process references removed or replaced. The compiler generates new IDs, references, diagram and configured destinations. These are component defaults for a limited schema, not a catalogue of every SAP adapter version or setting.

Sources (pinned revisions):

| Components | Source |
| --- | --- |
| General Splitter 1.5.1 and OData V2 receiver 1.20.0 | [SAP-samples/integration-suite-learning-journey](https://github.com/SAP-samples/integration-suite-learning-journey/tree/fe681076310edb62a2f62e5f7a8d7288c0245fb7), `rev_20.zip` → `DelayedDelivery_01_Package.zip` → `DelayedDelivery_Process.iflw`. Apache-2.0. |
| JSON to XML 1.1.2, Local Integration Process 1.1.3, Process Call 1.0.3 | [SAP-samples/connecting-systems-services-integration-suite-codejam](https://github.com/SAP-samples/connecting-systems-services-integration-suite-codejam/tree/b4fbfeb2d0c1fc6e6e94874e88e3dd2ece513f00), exported iFlows under `assets/cloud-integration/`. Apache-2.0. |
| Gather, parallel/sequential Multicast, Join, SFTP sender/receiver, XSLT Mapping 1.2.0, XML Validator 2.2.3 | [stevedpedersen/cpilint](https://github.com/stevedpedersen/cpilint/tree/cfdb4fd036bf6fdf987e8204378330703f4de267), `resources/IF_LINT_NAMES.zip`. MIT, copyright Morten N. Wittrock. |
| Timer definition, JMS receiver, Send | Same cpilint revision, `resources/iflow-alt-example-zipped.zip`. MIT. |

License texts are included as `LICENSE-SAP-samples.txt` and `LICENSE-cpilint.txt`. Local start/end events also reuse the existing Google Ads example already shipped in the base repository.

Changes to template defaults include OData timeout `60` seconds (SAP validation accepts 1–300), named Multicast branches, regenerated sequential route order, blanked adapter destinations/aliases and concrete JMS defaults instead of externalized sample parameters. SFTP sender post-processing is set explicitly in the template and must be reviewed for a real scenario.

SAP references:

- [Gather and Join](https://help.sap.com/docs/integration-suite/sap-integration-suite/define-gather-and-join)
- [General Splitter](https://github.com/SAP-docs/btp-integration-suite/blob/main/docs/ci/Development/define-general-splitter-a6c1916.md)
- [Adapter configuration](https://help.sap.com/docs/cloud-integration/sap-cloud-integration/configure-adapter-in-communication-channels)
- [SFTP sender](https://help.sap.com/docs/cloud-integration/sap-cloud-integration/configure-sftp-sender-adapter)

SAP validation, build status, editor compatibility and successful business execution are separate checks. No template by itself certifies all four.

XSLT Mapping uses bundled resources only, String output by default. XML Validator uses bundled XSD only and `preventException=false` so invalid messages fail. These defaults replace sample resource names and the sample validator setting that suppressed exceptions.
