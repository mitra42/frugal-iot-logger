---
title: "Farm IoT Interoperability Standard"
status: "Early Draft"
version: "0.1"
date: "2026-03-09"
authors:
  - name: "Mitra Ardron"
    affiliation: "Natural Innovation (naturalinnovation.org)"
    email: "mitra@mitra.biz"
---

# Farm IoT Interoperability Standard

## Abstract

This document defines the interoperability protocol between a Device-Platform
and a Farm-Platform. It specifies how sensor data is structured and communicated,
how a Farm-Platform makes requests of a Device-Platform, and how a Device-Platform
pushes data and notifications to a Farm-Platform.

---

## Status of This Document

This is an early draft. It has not yet been reviewed or adopted by any standards body.

The intended audiences at this time are:

- Developers of IoT devices and Device-Platforms (such as Frugal IoT or OurSci)
- Developers of Farm-Platforms (such as FarmOS or LiteFarm)
- Developers of solutions that integrate a Farm-Platform with multiple Device-Platforms

Feedback and contributions are welcomed from all communities with an interest in
open farm data interoperability.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Request Structure](#3-action-structure)
4. [Packet Format](#4-packet-format)
5. [Data Schema](#5-data-schema)
6. [Farm-Platform to Device-Platform](#6-farm-platform-to-device-platform)
7. [Device-Platform to Farm-Platform](#7-device-platform-to-farm-platform)
8. [Security Considerations](#8-security-considerations)
9. [Privacy Considerations](#9-privacy-considerations)
10. [References](#10-references)
11. [Known Limitations and Future Work](#11-known-limitations-and-future-work)

Annexes:
- [Annex A — Device Schema Field Definitions](#annex-a--device-schema-field-definitions)
- [Annex B — Example Device Schema](#annex-b--example-device-schema)
- [Annex C — User Stories](#annex-c--user-stories)
- [Annex D — Why This Is Not a Device-to-Backend API](#annex-d--why-this-is-not-a-device-to-backend-api)
- [Annex E — [Title]](#annex-e)

---

## 1. Introduction

### 1.1 Background

There is high potential, but very little use of IoT sensors in the Agroecology
space, due to cost and lack of integration between systems.

Projects like Frugal IoT and OurSci are building affordable devices for the
Agro-Ecology space that deliver real-time data, or one-off (e.g. lab soil
measurement) data. To be useful, data from these devices needs to be available
inside agroecology platforms (LiteFarm, FarmOS, etc.) where it can be integrated
with other data, or used for example for predictions and recommendations.

If, for example, Frugal IoT integrates only with LiteFarm, this creates lock-in
for farmers: if they choose to move to FarmOS, their devices become unusable
eWaste. Implementing interfaces between multiple platforms and multiple device
projects turns into a significant problem quickly. Each integration requires time
and resources from over-stretched and under-funded teams.

The solution is to specify a common interface (an API). Each Farm-Platform
implements one API, and each Device-Platform implements one API. Any farmer can
then choose their preferred devices and their preferred platform, knowing they
will work together.

### 1.2 Scope

This standard is concerned exclusively with communication between a
Device-Platform and a Farm-Platform. It does not specify:

- Internal Device-to-Device-Platform communication protocols
- Control logic internal to any platform
- User interface or experience requirements for Farm-Platforms

Exception: modification of setpoints on control systems operating within
Devices may be within scope where relevant to interoperability (see Section 6.5).

### 1.3 Design Goals

- **Easy to implement** in the context of existing Farm-Platforms and
  Device-Platforms, minimising the burden on resource-constrained teams
- **Easy to extend** as needs evolve and experience is gained
- **Supports both static and streaming devices** — including single-reading
  devices (such as soil testers) and those delivering a continuous stream of
  readings (such as temperature and humidity sensors)
- **Supports actuation** — allows setpoint control and direct control of
  actuators such as irrigation systems

---

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119].

| Term | Definition |
|------|------------|
| **Common Farm Conventions (CFC)** | A specification for communicating farm data, using [JSON-LD — TBD] as the underlying data format. |
| **Device** | A sensor device deployed in the field or laboratory, equipped with communications capability and one or more sensors. Also referred to as "Node" or "Thing" in other contexts. *(FrugalIoT: node)* |
| **Device-Platform** | A platform to which Devices connect natively and which manages device communication. *(FrugalIoT: Server)* (e.g. frugaliot.naturalinnovation.org) |
| **Farm-Platform** | A platform that provides a user experience (UX) to farmers, aggregating data from one or more Farms. |
| **Farm** | A location comprising one or more Devices, treated as a logical group by a Farm-Platform. *(FrugalIoT: Project)* |
| **Actuation** | The process by which a platform sends a message to a Device causing a physical action, such as activating irrigation or adjusting an automated setpoint. |
| **Control** | Internal platform processes that interpret sensed data and trigger Actuation. Control logic is explicitly **out of scope** for this standard. Exception: modification of setpoints on control systems operating *within* Devices may be within scope where relevant to interoperability. |
| **Device Schema** | A per-device or per-platform document that maps field names (as used in the `n` field of SenML packets) to their semantic meaning for a Farm-Platform. See Section 5.2. |

---

## 3. Request Structure

### 3.1 Overview

This section defines the structure of requests used in both directions of
communication between Device-Platform and Farm-Platform. Requests defined
here are referenced by Section 6 (Farm-Platform requests) and Section 7
(Device-Platform notifications and push).

### 3.2 Request Format

All requests between Device-Platform and Farm-Platform use HTTP, with the
exception of Data Push and Notification requests which MAY also use MQTT
(see Section 7).

Requests MUST be made over HTTPS. HTTP (unencrypted) MUST NOT be used in
production deployments.

The base URL of the API endpoint is determined by the receiving platform and
communicated out-of-band during registration. No versioning prefix is included
in the path.

All requests MUST include the following HTTP headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` for JSON request bodies; `application/senml+json` for SenML packets |
| `Accept` | `application/json` or `application/senml+json` as appropriate |
| `Cookie` | Authentication token agreed during platform registration — see Sections 3.4 and 3.6 |

Request and response bodies MUST be encoded as UTF-8.

### 3.3 Request Types

| Request Type       | Direction | Description | Defined In |
|--------------------|---|---|---|
| Data Request       | Farm-Platform → Device-Platform | Request sensor data for a device over a time period | [Section 6.2](#62-request-data-for-a-device) |
| User Registration  | Farm-Platform → Device-Platform | Register a user with the Device-Platform | [Section 6.3](#63-register-a-user) |
| Device Registration | Farm-Platform → Device-Platform | Register a device to a user | [Section 6.4](#64-register-a-device-to-a-user) |
| Device Action      | Farm-Platform → Device-Platform | Send an action or setpoint change to a Device | [Section 6.5](#65-send-an-action-to-a-device) |
| Data Push          | Device-Platform → Farm-Platform | Push sensor data to the Farm-Platform | [Section 7.2](#72-push-sensor-data) |
| Notification       | Device-Platform → Farm-Platform | Send an event or alert notification | [Section 7.3](#73-send-a-notification) |

### 3.4 Authentication and Authorisation

Authentication between platforms is based on a token exchanged during the
platform registration process (see Section 3.6). The token MUST be presented
in all requests as an HTTP cookie. The cookie name and token value are agreed
during platform registration.

The process by which a token is obtained — i.e. the login or credential
exchange mechanism — is outside the scope of this standard at this time.

**Authorisation model**

For the purposes of this standard, the Device-Platform treats the Farm-Platform
as a single trusted actor. The Farm-Platform is assumed to have authenticated
its own users and to have determined what data and actions each user is
permitted to access. The Device-Platform does not perform per-user authorisation
— it authorises at the platform level and trusts the Farm-Platform to enforce
appropriate access controls for its users.

This model is intentionally simple and is expected to evolve. In particular,
finer-grained authorisation — for example, restricting a Farm-Platform to
accessing only specific devices — may be needed as implementations mature.
Implementors are encouraged to raise requirements arising from prototype
experience so they can be incorporated into a future version of this standard.

### 3.5 Error Handling

Where an action fails, the responding platform MUST return an appropriate HTTP
error status code. Response bodies for errors MUST be JSON and SHOULD include
a machine-readable `error` code and a human-readable `message`. For example:

```json
{
  "error": "device_not_found",
  "message": "No device found with the specified identifier."
}
```

The following error cases apply across multiple requests. Individual action
definitions in Sections 6 and 7 may define additional error cases specific to
that action.

| HTTP Status | Error Code | Meaning |
|---|---|---|
| `400 Bad Request` | `invalid_request` | The request is malformed, missing required fields, or contains invalid values |
| `401 Unauthorized` | `not_authenticated` | No valid authentication credential was provided (see Section 3.4) |
| `403 Forbidden` | `not_allowed` | The authenticated platform does not have permission to perform this action |
| `404 Not Found` | `device_not_found` | The specified device does not exist on this platform |
| `404 Not Found` | `user_not_found` | The specified user does not exist on this platform |
| `409 Conflict` | `already_exists` | The resource being created (user, device registration) already exists |
| `422 Unprocessable Entity` | `invalid_value` | The request is well-formed but a field value fails validation (e.g. out of range, wrong type) |
| `422 Unprocessable Entity` | `field_read_only` | The targeted field exists in the Device Schema but is not writable (it is a property, not an action) |
| `503 Service Unavailable` | `device_unavailable` | The target device is offline or unreachable |
| `500 Internal Server Error` | `server_error` | An unexpected error occurred on the receiving platform |

Platforms MUST NOT return a `200 OK` response for a failed action. Platforms
SHOULD NOT expose internal implementation details in error messages returned
to the caller.

### 3.6 Platform Registration

Before any requests can be exchanged, a Farm-Platform and a Device-Platform
MUST establish a bilateral registration. This is a one-time setup process
performed out-of-band between the operators of the two platforms, and is not
itself defined by this standard. However, the following information MUST be
agreed and recorded by both parties as part of registration:

| Item | Description |
|---|---|
| **Device-Platform base URL** | The base URL against which all Farm-Platform → Device-Platform action paths are resolved (e.g. `https://frugaliot.naturalinnovation.org/api`) |
| **Farm-Platform base URL** | The base URL against which all Device-Platform → Farm-Platform action paths are resolved |
| **Authentication token (Farm-Platform → Device-Platform)** | The token the Farm-Platform presents to authenticate requests to the Device-Platform |
| **Authentication token (Device-Platform → Farm-Platform)** | The token the Device-Platform presents to authenticate push and notification requests to the Farm-Platform |
| **Token delivery mechanism** | Agreed cookie name(s) for token presentation, per Section 3.4 |

The exact process for establishing registration — including how operators
exchange tokens securely — is outside the scope of this standard. Implementors
are encouraged to document their registration process and share experience
during prototype implementation, so that a future version of this standard may
define a more formal registration protocol.

---

## 4. Packet Format

### 4.1 Overview

This section defines the format of data packets exchanged between platforms,
regardless of transport method. All data packets in this standard MUST conform
to SenML as defined in [RFC 8428].

### 4.2 SenML Conformance

This standard uses SenML [RFC 8428] as its packet format. Implementations
MUST conform to RFC 8428 except where this section defines a narrower profile.

**Required fields**

Each SenML pack MUST contain at least one record. Every record MUST contain
exactly one value field — one of `v` (numeric), `vs` (string), `vb` (boolean),
or `vd` (data). Records without a value field are not permitted in this standard.

**Naming**

The `bn` (base name) field MUST be present in the first record of every pack
and MUST identify the device using the device identifier as defined in the
Device Schema (Section 5). The `n` (name) field in each subsequent record
MUST be a relative field specifier in `module/field` form (e.g.
`sht/temperature`), resolved against `bn` to form the fully qualified name.

**Time**

The `bt` (base time) field MUST be present in the first record of every pack
and MUST express an absolute Unix timestamp (a value ≥ 2^28 per RFC 8428).
Individual records MAY carry a `t` field to express a per-record timestamp
where readings in a batch were taken at different times. The `t` field MAY
be a relative value (i.e. an offset in seconds from `bt`), which is useful
for compactly expressing a sequence of readings within a batch. Relative `t`
values MUST be interpreted with respect to the `bt` of the same pack.

**Base name and base time separation**

Whilst RFC 8428 permits `bn` and `bt` to appear in the same record as data
fields, this standard REQUIRES that `bn` and `bt` are placed in a dedicated
first record containing no value fields. This makes packs easier to parse and
the device identity unambiguous. See the example in Section 4.4.

**Units**

Where a unit of measurement applies, the `u` (unit) field SHOULD be included
in each record. Units MUST conform to the SenML Units Registry defined in
RFC 8428. Where a Device Schema (Section 5) has been exchanged, the `u` field
MAY be omitted, as the receiving platform can resolve units from the schema.
Where `u` is present, it MUST be consistent with the unit defined in the
Device Schema.

**Batching**

A single pack MAY contain records from multiple fields of the same device,
representing a batch of measurements taken at the same or different times.
A pack MUST NOT contain records from more than one device (i.e. more than
one distinct `bn` value). This restriction may be revisited in a future
version of this standard if requests are introduced that explicitly retrieve
or push data across multiple devices in a single request.

**Unused RFC 8428 features**

The following RFC 8428 features are not used in this standard and
implementations are not required to support them: CBOR encoding, XML encoding,
EXI encoding, CoAP transport, and the `s` (sum) field.

### 4.3 Encoding

All implementations MUST support JSON encoding (`application/senml+json`).
CBOR encoding is not required by this standard.

### 4.4 Example Packet

The following is an example SenML packet conveying temperature and humidity
readings from a device:

```json
[
  {"bn": "dev/lotus/esp32-123456/", "bt": 1.276020076001e+09},
  {"n": "sht/temperature", "v": 32.0, "u": "Cel"},
  {"n": "sht/humidity", "v": 85.2, "u": "%RH"}
]
```

Where `bn` is the base name (device identifier prefix), `bt` is the base time
(Unix timestamp), `n` is the field name relative to the base name, `v` is the
numeric value, and `u` is the unit of measurement per [RFC 8428].

---

## 5. Data Schema

### 5.1 Overview

This section defines the semantic meaning of the data communicated within
packets conforming to Section 4. Rather than specifying a single fixed schema
for the standard, this section defines a mechanism by which a Device-Platform
can advertise the meaning of the fields its devices produce.

### 5.2 Device Schema

Each Device-Platform SHOULD provide a Device Schema for each device it manages.
A Device Schema exposes the properties and actions of a device in accordance with
the W3C Web of Things (WoT) Thing Description specification
(https://www.w3.org/TR/wot-thing-description11/).

The Device Schema enables a Farm-Platform to:
- Discover what fields a device produces and their types
- Determine which fields are readable (properties) and which are controllable (actions)
- Understand measurement units and value constraints
- Access Frugal IoT specific metadata through the `frugal-iot:metadata` namespace

The Device Schema is expressed as a JSON-LD document (a JSON object with linked data
semantics). The permitted fields and their definitions are specified in 
[Annex A](#annex-a--device-schema-field-definitions). A worked example of a complete 
Device Schema is provided in [Annex B](#annex-b--example-device-schema).

A Farm-Platform MAY fetch the Device Schema for a given device using:

```
GET /devices/schema?device={device-id}
```

The response MUST be a JSON object conforming to the W3C Thing Descriptor structure
defined in Annex A.

### 5.3 Field Conformance

Data fields in SenML packets SHOULD be drawn from the Device Schema. A
Farm-Platform that receives a field it does not recognise or does not require
MUST NOT treat this as an error — it SHOULD silently ignore unrecognised
fields. It is expected that a Device-Platform may communicate data that a
given Farm-Platform does not care about.

Where a response is returned to the Device-Platform, the Farm-Platform SHOULD
indicate which fields were accepted and which were ignored.

### 5.4 Extensibility

Implementations MAY add fields to the Device Schema beyond those defined in
Annex A. A receiving platform that encounters a schema field it does not
recognise MUST ignore it, consistent with the field conformance rules in
Section 5.3. Similarly, data fields in SenML packets that are not present
in the Device Schema MUST be ignored by the receiving platform.

Since Device Schemas use JSON-LD, vendor-specific extensions SHOULD use
namespace prefixes defined in the `@context`. For example, a Frugal IoT
specific extension would use the prefix `frugal-iot:` (e.g., `frugal-iot:metadata`),
and a LiteFarm specific extension would use `litefarm:`.

The structure `{field-name}: {vendor-prefix}:{property}` provides:

1. **Clear ownership** — the vendor prefix indicates who defined the property
2. **Namespace isolation** — prevents naming conflicts between independent implementations
3. **Graceful degradation** — generic WoT consumers can ignore vendor-specific properties
4. **Extensibility** — vendors can add custom properties without coordination

When defining namespaces, vendors SHOULD use stable URIs that identify their
organization or project, for example:

- Frugal IoT: `https://github.com/mitra42/frugal-iot/ns/`
- LiteFarm: `https://litefarm.org/ns/`

Vendors are encouraged to treat proprietary fields as temporary. Once a
vendor-defined field has been tested in practice and found to be of general
utility, the vendor SHOULD request its inclusion in this standard so that it
becomes available to all implementations without a vendor prefix.

---

## 6. Farm-Platform to Device-Platform

### 6.1 Overview

This section defines the requests and actions a Farm-Platform MAY issue to
a Device-Platform. All requests use HTTP. Requests MUST be authenticated as
defined in Section 3.4.

### 6.2 Request Data for a Device

#### 6.2.1 Purpose

Request historical or recent sensor data for a specific Device over a defined
time period.

#### 6.2.2 Request

```
GET /data?device={device-id}&from={timestamp}&to={timestamp}
```

| Parameter | Required | Description |
|---|---|---|
| `device` | MUST | Fully qualified device identifier (e.g. `dev/lotus/esp1234/sht/temperature`) |
| `from` | MUST | Start of time period (ISO 8601 or Unix timestamp) |
| `to` | SHOULD | End of time period (ISO 8601 or Unix timestamp). Defaults to now if omitted. |

#### 6.2.3 Response

A SenML packet (Section 4) containing data conforming to the Device Schema
(Section 5). The response MAY include data points outside the requested time
period — it is the requester's responsibility to filter out any records that
fall outside the requested range. Implementations SHOULD document their
behaviour in this regard.

If no data exists within the requested time period, the Device-Platform MUST
return `200 OK` with an empty SenML pack (`[]`). This is not an error
condition.

#### 6.2.4 Error Cases

See Section 3.5 for common error codes. The following error case is specific
to this request:

| HTTP Status | Error Code | Notes |
|---|---|---|
| `404 Not Found` | `device_not_found` | The Device-Platform does not recognise the specified device identifier |

---

### 6.3 Register a User

#### 6.3.1 Purpose

Register a Farm-Platform user with the Device-Platform, enabling subsequent
device registration and data access.

#### 6.3.2 Request

```
POST /users/register
```

```json
{
  "user-id": "[farm-platform-user-id]",
  "credentials": { "[TBD]" }
}
```

#### 6.3.3 Response

```json
{
  "status": "registered",
  "device-platform-user-id": "[id]"
}
```

#### 6.3.4 Error Cases

See Section 3.5 for common error codes. The following error case is specific
to this request:

| HTTP Status | Error Code | Notes |
|---|---|---|
| `409 Conflict` | `already_exists` | A user with the specified identifier is already registered on this Device-Platform |

---

### 6.4 Register a Device to a User

#### 6.4.1 Purpose

Associate a Device with a registered user on the Device-Platform. The
Device-Platform MUST already know the device — `device_not_found` in this
context means the Device-Platform has no record of a device with the given
identifier, not that the physical device is unreachable.

#### 6.4.2 Request

```
POST /devices/register
```

```json
{
  "user-id": "[device-platform-user-id]",
  "farm-platform-device-id": "[farm-platform-device-identifier]",
  "metadata": { "[TBD]" }
}
```

#### 6.4.3 Response

```json
{
  "status": "registered",
  "device-platform-device-id": "[id]"
}
```

#### 6.4.4 Error Cases

See Section 3.5 for common error codes. The following error cases are specific
to this request:

| HTTP Status | Error Code | Notes |
|---|---|---|
| `404 Not Found` | `device_not_found` | The Device-Platform does not recognise the specified device identifier — the device must be known to the Device-Platform before it can be registered to a user |
| `404 Not Found` | `user_not_found` | The specified user is not registered on this Device-Platform |
| `409 Conflict` | `already_exists` | The device is already registered to a user on this Device-Platform |

---

### 6.5 Send a Action to a Device

#### 6.5.1 Purpose

Send an action to a Device via the Device-Platform. This is the primary
mechanism for Actuation and setpoint control as defined in the Terminology
(Section 2).

Any field defined in the Device Schema (Annex A) as an action (i.e., present in 
the `actions` object) is an acceptable target for a device action. The `action` 
field in the request MUST be the fully qualified field specifier, combining the 
module name and field name in the same form used in the `n` field of SenML packets.
The `value` parameter MUST conform to the type defined for that field in the
Device Schema (Section 5).

For example, a text field such as `frugal_iot/name` would be set with a
string value, while a boolean field such as `relay/on` would be set with a
boolean value.

#### 6.5.2 Request

```
POST /devices/action
```

```json
{
  "device-id": "[device-identifier]",
  "action": "[module/field]",
  "parameters": {
    "value": "[value conforming to field type]"
  }
}
```

Examples:

```json
{
  "device-id": "dev/developers/esp32-e4d5f6",
  "action": "main/description",
  "parameters": {
    "value": "Sensor by the apple tree"
  }
}
```

```json
{
  "device-id": "dev/developers/esp32-e4d5f6",
  "action": "relay/on",
  "parameters": {
    "value": true
  }
}
```

#### 6.5.3 Response

```json
{
  "status": "accepted | rejected",
  "reason": "[optional explanation]"
}
```

#### 6.5.4 Error Cases

See Section 3.5 for common error codes. The following error cases are specific
to this request:

| HTTP Status | Error Code | Notes |
|---|---|---|
| `404 Not Found` | `device_not_found` | The Device-Platform does not recognise the specified device identifier |
| `422 Unprocessable Entity` | `field_read_only` | The specified field exists in the Device Schema but is not writable (it is a property, not an action) |
| `422 Unprocessable Entity` | `invalid_value` | The supplied value does not conform to the field type or falls outside the `minimum`/`maximum` range defined in the Device Schema |
| `503 Service Unavailable` | `device_unavailable` | The Device-Platform recognises the device but it is currently offline or unreachable |

---

## 7. Device-Platform to Farm-Platform

### 7.1 Overview

This section defines how a Device-Platform communicates with a Farm-Platform,
both to push sensor data and to send notifications. Transport MAY use HTTP POST
or MQTT. [Further requests to be defined.]

### 7.2 Push Sensor Data

#### 7.2.1 Purpose

Push one or more sensor readings from one or more Devices to the Farm-Platform.
This is the primary mechanism by which a Device-Platform delivers data without
an explicit request from the Farm-Platform.

#### 7.2.2 Request

```
POST /data
```

The request body MUST be a SenML packet (Section 4) which already encodes the
device identifier (via `bn`) and timestamps (via `bt` or `t`). No device
identifier is required in the URL.

#### 7.2.3 Response

On success the Farm-Platform MUST return `200 OK`. The response SHOULD include
a JSON body indicating which fields were accepted and which were ignored (per
Section 5.3). For example:

```json
{
  "status": "ok",
  "accepted": ["sht/temperature", "sht/humidity"],
  "ignored": ["main/rssi"]
}
```

Where the JSON body is included, the `ignored` array MUST be present but MAY
be empty, and the `accepted` array MUST be present but MAY be empty.

#### 7.2.4 Error Cases

See Section 3.5 for common error codes. The following error case is specific
to this request:

| HTTP Status | Error Code | Notes |
|---|---|---|
| `404 Not Found` | `device_not_found` | The `bn` value in the SenML pack does not match any device known to this Farm-Platform |
| `400 Bad Request` | `invalid_request` | The request body is not a valid SenML pack per Section 4 |

---

### 7.3 Send a Notification

#### 7.3.1 Purpose

Send an event or alert notification from the Device-Platform to the
Farm-Platform — for example, to alert a farmer that a threshold has been
exceeded. Note that this standard does not yet define a request for a
Farm-Platform to register or configure notification rules on a Device-Platform;
that mechanism is reserved for a future version.

#### 7.3.2 Request

```
POST /notification
```

The request body MUST be a SenML packet (Section 4). Notifications SHOULD use
a string value field (`vs`) to carry a human-readable message. For example:

```json
[
  {"bn": "dev/lotus/esp32-123456/", "bt": 1.276020076001e+09},
  {"n": "message", "vs": "Your paddock is too dry"}
]
```

Additional structured fields MAY be included in the same pack to provide
machine-readable context alongside the human-readable message. For example,
a current sensor reading that triggered the notification:

```json
[
  {"bn": "dev/lotus/esp32-123456/", "bt": 1.276020076001e+09},
  {"n": "message", "vs": "Your paddock is too dry"},
  {"n": "sht/humidity", "v": 0, "u": "%RH"}
]
```

#### 7.3.3 Response

On success the Farm-Platform MUST return `200 OK` with no required response body.

#### 7.3.4 Error Cases

See Section 3.5 for common error codes. The following error case is specific
to this request:

| HTTP Status | Error Code | Notes |
|---|---|---|
| `404 Not Found` | `device_not_found` | The `bn` value in the SenML pack does not match any device known to this Farm-Platform |

### 7.4 [Further requests TBD]

---

## 8. Security Considerations

[Describe security implications — authentication between platforms, data
integrity, authorisation of requests, risks of unauthenticated Actuation.]

---

## 9. Privacy Considerations

[Describe privacy implications — what farm and sensor data is transmitted, data
minimisation requirements, obligations on platform implementors.]

---

## 10. References

### 10.1 Normative References

- [RFC 2119] Bradner, S. "Key words for use in RFCs to Indicate Requirement
  Levels". IETF, 1997. https://www.rfc-editor.org/rfc/rfc2119
- [RFC 8428] Jennings, C. et al. "Sensor Measurement Lists (SenML)". IETF, 2018.
  https://www.rfc-editor.org/rfc/rfc8428

### 10.2 Informative References

- [[REF]] [Author]. "[Title]". [Publisher], [Year]. [URL]

---

## 11. Known Limitations and Future Work

This standard is at an early stage. The following areas are known to be
incomplete or unaddressed, and are identified here so that implementors and
readers understand the current boundaries of the specification.

### 11.1 User-Device Relationships

This standard defines requests for registering a user with a Device-Platform
(Section 6.3) and registering a device to a user (Section 6.4), but does not
yet fully specify the relationship model between users, devices, and farms.
Open questions include: how a Farm-Platform discovers which devices are
associated with a given user; how ownership or access rights are transferred
between users; and how a device is deregistered or disassociated from a user.

### 11.2 Notification Configuration

Section 7.3 defines how a Device-Platform sends a notification to a
Farm-Platform, but this standard does not yet define how a Farm-Platform
registers interest in notifications, configures thresholds, or subscribes to
specific event types on a Device-Platform. A mechanism for notification setup
is needed and is reserved for a future version.

### 11.3 MQTT Transport

Section 7 notes that Device-Platform to Farm-Platform communication MAY use
MQTT, but the details of MQTT topic structure, QoS levels, authentication,
and session management are not yet specified.

### 11.4 Multi-Device Data Requests

Section 4 restricts a single SenML pack to data from one device. A future
version may introduce requests that allow a Farm-Platform to request or receive
data from multiple devices in a single operation, at which point the
single-device-per-pack restriction may be revisited (see Section 4.2).

### 11.5 Authentication and Authorisation

Section 3.4 identifies authentication as a required mechanism but does not
yet specify the authentication scheme. Decisions on bearer tokens, API keys,
OAuth2, or other mechanisms are deferred to a future version.

### 11.6 Device Schema Discovery

This standard defines how a Farm-Platform fetches the Device Schema for a
known device (Section 5.2), but does not define how a Farm-Platform discovers
which devices are available on a Device-Platform, or how it learns that a new
device has been added.

### 11.7 Diagnostics and Device Status

This standard does not yet define any mechanism for querying the status or
health of devices at scale. In practice, a Farm-Platform such as LiteFarm
may need to determine — in a single operation — which of its registered
devices are online, offline, or reporting errors. Similar needs exist at the
level of a specific platform user, for example retrieving the last-seen time
and connection status of all devices belonging to a particular farmer.

A future version of this standard should define a diagnostic query request
that supports filtering by Farm-Platform, by platform user, or by device
group, and returns status information such as connectivity state, last
reported timestamp, and any active error conditions.

---

## Annex A — Device Schema Field Definitions

**(Normative for structure, Informative for content)**

This annex defines the permitted fields in a Device Schema document. A Device
Schema MUST be a valid JSON-LD object conforming to the W3C Web of Things
Thing Description specification version 1.1. The top-level structure is as follows:

```json
{
  "@context": [
    "https://www.w3.org/2022/wot/td/v1.1",
    {
      "frugal-iot": "https://github.com/mitra42/frugal-iot/ns/"
    }
  ],
  "id": <string>,
  "title": <string>,
  "description": <string>,
  "base": <string>,
  "securityDefinitions": { ... },
  "security": [ ... ],
  "properties": {
    "<field-id>": <property-object>,
    ...
  },
  "actions": {
    "<field-id>": <action-object>,
    ...
  }
}
```

### A.1 Top-Level Fields

| Field | Required | Type | Description |
|---|---|---|---|
| `@context` | MUST | array | JSON-LD context, MUST include W3C WoT context and optionally custom vocabularies |
| `id` | MUST | string | The device identifier as used by the Device-Platform, in the format `org/project/device` |
| `title` | MUST | string | Human-readable title for the device |
| `description` | SHOULD | string | Human-readable description of the device |
| `base` | SHOULD | string | Base URI for relative form URLs (e.g. `https://frugaliot.naturalinnovation.org`) |
| `securityDefinitions` | SHOULD | object | Security scheme definitions. SHOULD include at least `basic_sc` for HTTP Basic Authentication |
| `security` | SHOULD | array | References to applicable security scheme definitions |
| `properties` | MAY | object | Map of readable fields to property objects (see A.2) |
| `actions` | MAY | object | Map of controllable fields to action objects (see A.3) |


### A.2 Property Object

A property represents a readable field or sensor value from the device. Each property
is identified by a field ID in the format `module/field` (e.g., `sht/temperature`).

```json
{
  "type": <string>,
  "title": <string>,
  "description": <string>,
  "unit": <string>,
  "minimum": <number>,
  "maximum": <number>,
  "readOnly": true,
  "frugal-iot:metadata": { ... },
  "forms": [
    {
      "href": <string>,
      "contentType": "application/json",
      "op": ["readproperty"],
      "subprotocol": <string>
    },
    ...
  ]
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | MUST | string | JSON Schema type. One of: `number`, `integer`, `boolean`, `string`, `object`, `array` |
| `title` | MUST | string | Human-readable label for the field (e.g., `"Temperature"`) |
| `description` | SHOULD | string | Human-readable description of the field |
| `unit` | SHOULD | string | Unit of measurement, conforming to RFC 8428 / UCUM notation (e.g., `"Cel"`, `"%RH"`) |
| `minimum` | MAY | number | Minimum valid value (numeric fields only) |
| `maximum` | MAY | number | Maximum valid value (numeric fields only) |
| `readOnly` | SHOULD | boolean | MUST be `true` for properties |
| `frugal-iot:metadata` | MAY | object | Frugal IoT specific metadata (see A.4) |
| `forms` | MUST | array | Array of form objects describing how to access the property |

### A.3 Action Object

An action represents a controllable (write-only) field that can be set on the device.
Each action is identified by a field ID in the format `module/field`.

```json
{
  "title": <string>,
  "description": <string>,
  "input": {
    "type": <string>,
    "title": <string>,
    "writeOnly": true,
    "frugal-iot:metadata": { ... }
  },
  "forms": [
    {
      "href": <string>,
      "contentType": "application/json",
      "op": ["invokeaction"],
      "subprotocol": <string>
    },
    ...
  ]
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `title` | MUST | string | Human-readable label for the action |
| `description` | SHOULD | string | Human-readable description of the action |
| `input` | MUST | object | Input schema object (see below) |
| `forms` | MUST | array | Array of form objects describing how to invoke the action |

The `input` object uses the same structure as property objects, with:

| Field | Required | Type | Description |
|---|---|---|---|
| `type` | MUST | string | JSON Schema type defining the input value type |
| `title` | MUST | string | Human-readable label for the input |
| `writeOnly` | SHOULD | boolean | MUST be `true` for action inputs |
| `unit` | MAY | string | Unit of measurement (if applicable) |
| `minimum` | MAY | number | Minimum valid value (numeric inputs only) |
| `maximum` | MAY | number | Maximum valid value (numeric inputs only) |
| `frugal-iot:metadata` | MAY | object | Frugal IoT specific metadata |

### A.4 Form Object

Form objects describe how to access a property or invoke an action. Each form
specifies a URI and protocol.

| Field | Required | Type | Description |
|---|---|---|---|
| `href` | MUST | string | The URI for accessing the property or invoking the action |
| `contentType` | SHOULD | string | Media type. SHOULD be `application/json` for this standard |
| `op` | MUST | array | Array of operations: `["readproperty"]` for properties, `["invokeaction"]` for actions |
| `subprotocol` | MAY | string | Optional protocol specification, e.g., `"mqtt"` for MQTT bindings |

### A.5 Frugal IoT Metadata Object

The `frugal-iot:metadata` object preserves Frugal IoT specific field attributes
that are not part of the standard W3C Thing Descriptor. This allows Frugal IoT
aware consumers to access extended metadata while remaining compatible with
generic WoT consumers.

| Field | Required | Type | Description |
|---|---|---|---|
| `slot` | MAY | string | Binds the field to a named platform concept (e.g., `"lastseen"`). Platform-defined. |
| `retain` | MAY | boolean | If `true`, the last known value persists across device reboots or reconnections |
| `log` | MAY | boolean | If `true`, the Device-Platform records a time-series history of this field |
| `duplicates` | MAY | object | Controls when a new reading is considered significant (see A.6) |
| `display` | MAY | string | Hint for how to render the field. One of: `bar`, `text`, `gauge`, `map`, `color`, `slider`, `toggle` |
| `color` | MAY | string | Display colour for the field, as a CSS colour name or hex value |
| `graphable` | MAY | boolean | If `true`, the field is suitable for time-series graphing |
| `wireable` | MAY | boolean | If `true`, the field may be connected to other fields for display or control purposes |

Any additional Frugal IoT specific properties defined by implementations
SHOULD be included in this object with a descriptive field name.

### A.6 Duplicates Object (Frugal IoT Extension)

The `duplicates` object controls deduplication of readings. A new reading is
only considered significant — and therefore stored or forwarded — if it
differs from the previous reading by more than the defined threshold.

| Field | Required | Type | Description |
|---|---|---|---|
| `significantdate` | MAY | number | Minimum time interval between stored readings, in milliseconds |
| `significantvalue` | MAY | number or string | Minimum change in value required for a reading to be stored. A plain number is an absolute delta; a string ending in `%` denotes a relative change (e.g., `"2%"`) |

---

## Annex B — Example Device Schema

**(Informative)**

The following is an example Device Schema (W3C Thing Descriptor) for an ESP32-based 
device with an SHT temperature/humidity sensor module and metadata fields. This 
example is provided for illustration only and does not constitute a normative definition.

```json
{
  "@context": [
    "https://www.w3.org/2022/wot/td/v1.1",
    {
      "sosa": "http://www.w3.org/ns/sosa/",
      "ssn": "http://www.w3.org/ns/ssn/",
      "frugal-iot": "https://github.com/mitra42/frugal-iot/ns/"
    }
  ],
  "id": "dev/developers/esp32-e4d5f6",
  "title": "Frugal IoT Device - esp32-e4d5f6",
  "description": "IoT device esp32-e4d5f6 in project developers/dev",
  "base": "https://frugaliot.naturalinnovation.org",
  "securityDefinitions": {
    "basic_sc": {
      "scheme": "basic",
      "in": "header"
    }
  },
  "security": ["basic_sc"],
  "forms": [
    {
      "href":   "https://frugaliot.naturalinnovation.org/property?deiceId=dev%2Flotus%2Fesp8266-fb94bb",
      "op": "readallproperties",
      "contentType": "application/senml+json"
    },
    {
      "href": "mqtt://broker.example.com",
      "op": ["observeallproperties","unobserveallproperties"],
      "mqv:filter": `dev/developers/esp32-e4d5f6/#`,
      "contentType":  "text/plain"
    }
  ],
  "properties": {
    "sht/temperature": {
      "type": "number",
      "title": "Temperature",
      "description": "Temperature",
      "unit": "Cel",
      "minimum": 0,
      "maximum": 50,
      "readOnly": true,
      "frugal-iot:metadata": {
        "display": "bar",
        "color": "red",
        "graphable": true,
        "wireable": false,
        "log": true,
        "duplicates": {
          "significantdate": 900000,
          "significantvalue": "2%"
        }
      },
      "forms": [
        {
          "href": "https://frugaliot.naturalinnovation.org/device/get?deviceId=dev%2Fdevelopers%2Fesp32-e4d5f6&key=sht%2Ftemperature",
          "contentType": "application/json",
          "op": ["readproperty"]
        },
        {
          "href": "mqtt://broker.example.com/dev/developers/esp32-e4d5f6/sht/temperature",
          "contentType": "text/plain",
          "op": ["readproperty"],
          "subprotocol": "mqtt"
        }
      ]
    },
    "sht/humidity": {
      "type": "number",
      "title": "Humidity",
      "description": "Humidity",
      "unit": "%RH",
      "minimum": 0,
      "maximum": 100,
      "readOnly": true,
      "frugal-iot:metadata": {
        "display": "bar",
        "color": "blue",
        "graphable": true,
        "log": true,
        "duplicates": {
          "significantdate": 900000,
          "significantvalue": 1
        }
      },
      "forms": [
        {
          "href": "https://frugaliot.naturalinnovation.org/device/get?deviceId=dev%2Fdevelopers%2Fesp32-e4d5f6&key=sht%2Fhumidity",
          "contentType": "application/json",
          "op": ["readproperty"]
        },
        {
          "href": "mqtt://broker.example.com/dev/developers/esp32-e4d5f6/sht/humidity",
          "contentType": "text/plain",
          "op": ["readproperty"],
          "subprotocol": "mqtt"
        }
      ]
    },
    "frugal_iot/description": {
      "type": "string",
      "title": "Description",
      "description": "Description",
      "readOnly": true,
      "forms": [
        {
          "href": "https://frugaliot.naturalinnovation.org/device/get?deviceId=dev%2Fdevelopers%2Fesp32-e4d5f6&key=frugal_iot%2Fdescription",
          "contentType": "application/json",
          "op": ["readproperty"]
        }
      ]
    }
  },
  "actions": {
    "frugal_iot/name": {
      "title": "Name",
      "description": "Name",
      "input": {
        "type": "string",
        "writeOnly": true,
        "frugal-iot:metadata": {
          "display": "text",
          "retain": true
        }
      },
      "forms": [
        {
          "href": "https://frugaliot.naturalinnovation.org/device/action?deviceId=dev%2Fdevelopers%2Fesp32-e4d5f6&action=frugal_iot%2Fname",
          "contentType": "application/json",
          "op": ["invokeaction"]
        },
        {
          "href": "mqtt://broker.example.com/dev/developers/esp32-e4d5f6/set/frugal_iot/name",
          "contentType": "application/json",
          "op": ["invokeaction"],
          "subprotocol": "mqtt"
        }
      ]
    }
  }
}
```

**Key points in this example:**

1. **@context** - Includes the W3C WoT 1.1 context and custom vocabulary namespaces
2. **id** - Uses the Frugal IoT device identifier format: `org/project/device`
3. **properties** - Contains readable sensor data with measurement units and constraints
4. **actions** - Contains controllable/writable fields
5. **frugal-iot:metadata** - Preserves Frugal IoT specific attributes like `display`, `color`, `retain`, and `duplicates`
6. **forms** - Specifies both HTTP REST and MQTT protocol bindings for accessing data
7. **contentType** - Indicates JSON format for request/response bodies

---

## Annex C — User Stories

**(Informative)**

This annex illustrates how the requests defined in this standard fit together
in practice, through a series of user stories. Each step references the
relevant request or section. These stories are illustrative only and do not
constitute normative requirements.

---

### C.1 A Farmer Adds a New Device to Their Farm Platform

**Actors:** A farmer already using a Farm-Platform (e.g. LiteFarm); a
Device-Platform (e.g. Frugal IoT) that manages the farmer's device.

**Precondition:** The Farm-Platform and Device-Platform have completed
platform registration ([Section 3.6](#36-platform-registration)), including
exchange of base URLs and authentication tokens.

**Story:**

1. The farmer navigates to an "Add Device" screen within their Farm-Platform
   (e.g. LiteFarm). This is internal to the Farm-Platform and outside the
   scope of this standard.

2. The farmer enters the device identifier as provided by their device supplier
   (e.g. printed on the device or in accompanying documentation).

3. The farmer enters the physical location of the device — either by typing a
   GPS coordinate or placing a marker on a map. This step is manual, as most
   low-cost devices do not include a GPS chip. This is internal to the
   Farm-Platform and outside the scope of this standard.

4. The Farm-Platform registers the farmer as a user on the Device-Platform, if
   not already registered.
   → [Section 6.3 — Register a User](#63-register-a-user)

5. The Farm-Platform registers the device to the farmer's account on the
   Device-Platform, providing its own identifier for the device alongside the
   device identifier supplied by the farmer.
   → [Section 6.4 — Register a Device to a User](#64-register-a-device-to-a-user)

6. The Device-Platform records that data for this device should be forwarded
   to the Farm-Platform, and stores the Farm-Platform's device identifier for
   future use (as `farm-platform-device-id` in the Device Schema).

7. The Farm-Platform fetches the Device Schema for the newly registered device,
   learning what fields the device produces, their types, units, and any
   display hints.
   → [Section 5.2 — Device Schema](#52-device-schema)

8. The Farm-Platform uses the Device Schema to configure its user interface for
   this device — for example, creating a dashboard widget for each field. It
   MAY use the display hints in the schema (such as `display: "bar"` for
   temperature) to inform how each field is presented, but is not required to
   do so.
   → [Annex A.2 — Property Object](#a2-property-object) and [Annex A.5 — Frugal IoT Metadata Object](#a5-frugal-iot-metadata-object)

9. Periodically, the Farm-Platform requests recent sensor data for the device
   and updates its display. It filters any records outside the requested time
   range client-side.
   → [Section 6.2 — Request Data for a Device](#62-request-data-for-a-device)

---

### C.2 A Farmer Views Historical Sensor Data

**Actors:** A farmer using a Farm-Platform (e.g. LiteFarm); a Device-Platform
(e.g. Frugal IoT) that manages the farmer's device.

**Precondition:** The farmer has already added the device to their Farm-Platform
as described in [Annex C.1](#c1-a-farmer-adds-a-new-device-to-their-farm-platform).
The Farm-Platform already has the Device Schema for this device and knows what
fields it produces (e.g. `sht/temperature` and `sht/humidity`).

**Story:**

1. The farmer navigates to a historical view or graph for one of their devices
   within the Farm-Platform. This is internal to the Farm-Platform and outside
   the scope of this standard.

2. The Farm-Platform requests data for the device over the relevant time range
   — for example, the past 7 days.
   → [Section 6.2 — Request Data for a Device](#62-request-data-for-a-device)

3. The Device-Platform returns a SenML packet containing the historical
   readings for the requested period. The response may include data points
   slightly outside the requested range; the Farm-Platform filters these
   client-side.
   → [Section 6.2.3 — Response](#623-response)
   → [Section 4 — Packet Format](#4-packet-format)

4. Because the Farm-Platform already retrieved the Device Schema during
   registration ([Annex C.1, step 7](#c1-a-farmer-adds-a-new-device-to-their-farm-platform)),
   it already understands the meaning, units, and display hints for each field
   in the returned data. No additional schema lookup is required.

5. The Farm-Platform displays the data — for example, as a time-series graph
   of temperature and humidity. It MAY use the display hints from the Device
   Schema (e.g. `color`, `graphable`) to style the presentation, but is not
   required to do so.
   → [Annex A.5 — Frugal IoT Metadata Object](#a5-frugal-iot-metadata-object)

6. If the farmer scrolls or pages to an earlier time period, the Farm-Platform
   issues a further data request for the new time range. Each request is
   independent and follows the same pattern as step 2. The Farm-Platform MAY
   cache previously retrieved data to avoid redundant requests.
   → [Section 6.2 — Request Data for a Device](#62-request-data-for-a-device)

---

### C.3 A User Submits Point-Source Sensor Data via a Survey Tool

*Note: This section is a placeholder and may be edited by Greg Austic.*

**Actors:** A farmer or field technician using a Farm-Platform (e.g. LiteFarm);
a survey and data collection tool (e.g. SurveyStack) acting as a Device-Platform.

**Precondition:** The Farm-Platform and SurveyStack have completed platform
registration ([Section 3.6](#36-platform-registration)). The farmer has
identified SurveyStack as a device source within LiteFarm, following a process
similar to [Annex C.1](#c1-a-farmer-adds-a-new-device-to-their-farm-platform).

**Story:**

1. The LiteFarm user identifies a SurveyStack survey instrument (e.g. a soil
   reflectometer) as a device within LiteFarm. This is internal to LiteFarm
   and outside the scope of this standard.

2. The user takes a measurement in the field using the reflectometer and enters
   the resulting data into SurveyStack, including the GPS location of the
   measurement. This is a point-source, one-off reading rather than a
   continuous stream — the device does not transmit data autonomously.

3. SurveyStack pushes the measurement data to LiteFarm using the data push
   request. The SenML packet encodes the device identifier, the timestamp of
   the measurement, the GPS location, and the measured values.
   → [Section 7.2 — Push Sensor Data](#72-push-sensor-data)
   → [Section 4 — Packet Format](#4-packet-format)

4. LiteFarm receives the data, acknowledges it, and records which fields were
   accepted and which were ignored.
   → [Section 7.2.3 — Response](#723-response)

5. LiteFarm displays the point-source reading within its interface, for example
   as a georeferenced data point on a field map.

---

### C.4 A Farmer Turns On Irrigation via Their Farm Platform

**Actors:** A farmer using a Farm-Platform (e.g. LiteFarm); a Device-Platform
(e.g. Frugal IoT) managing a device with an irrigation relay actuator.

**Precondition:** The farmer has already added the device to their Farm-Platform
as described in [Annex C.1](#c1-a-farmer-adds-a-new-device-to-their-farm-platform).
The Device Schema for the device includes a writable field for irrigation
control (e.g. `relay/on`, type `boolean`, `rw: "w"`).

**Story:**

1. The farmer reviews sensor data on their LiteFarm dashboard — for example,
   a soil moisture reading indicating the field is too dry. This is internal
   to LiteFarm and outside the scope of this standard.

2. The farmer decides to turn on irrigation for 50 minutes and enters this
   instruction via LiteFarm's interface. This is internal to LiteFarm and
   outside the scope of this standard.

3. LiteFarm sends a command to Frugal IoT to turn the irrigation relay on.
   → [Section 6.5 — Send an Action to a Device](#65-send-an-action-to-a-device)

   ```json
   {
     "device-id": "dev/joesfarm/esp32-e4d5f6",
     "action": "relay/on",
     "parameters": { "value": true }
   }
   ```

4. Frugal IoT receives the action, forwards it to the device, and returns
   an `accepted` response to LiteFarm.
   → [Section 6.5.3 — Response](#653-response)

5. The device activates the irrigation relay.

6. The device activates the irrigation relay. After 50 minutes, LiteFarm
   sends a further action to Frugal IoT to turn the relay off.
   → [Section 6.5 — Send an Action to a Device](#65-send-an-action-to-a-device)

   ```json
   {
     "device-id": "dev/joesfarm/esp32-e4d5f6",
     "action": "relay/on",
     "parameters": { "value": false }
   }
   ```

---

### C.5 [Further user stories TBD]

---

## Annex D — Why This Is Not a Device-to-Backend API

**(Informative)**

Legitimate questions have been raised as to why this standard defines a
platform-to-platform API rather than a device-to-backend API — one that
would allow devices to speak directly to any Farm-Platform without the
intermediary of a Device-Platform. This annex explains the reasoning.

The combination of the following factors makes it impractical to assume that
devices can act as first-class API participants. This standard should not,
however, preclude a larger or more capable device from speaking the API
directly where it has the connectivity and capacity to do so.

**Most devices do not have stable IP addresses**

The majority of IoT devices in the agroecology space are not directly
addressable on the internet. They typically operate under one or more of the
following conditions: behind a NAT on a temporary WiFi IP address;
intermittently connected via variable means such as Bluetooth Low Energy
(BLE) to a phone; or behind a low-bandwidth radio protocol such as LoRa,
which has no concept of IP addressing at all. A platform-to-platform API
sidesteps these constraints entirely, as both platforms are persistent,
addressable internet services.

**Devices are often already fully deployed**

Many devices in the field have firmware blown at manufacture and cannot
easily be updated. Requiring those devices to implement a new API is
impractical. A Device-Platform, by contrast, is software running on a server
and can be updated independently of the physical devices it manages.

**Devices have severe resource constraints**

Typical devices in this space — for example ESP32-based sensors — have
approximately 4MB of flash storage. Supporting two firmware images for
over-the-air (OTA) updates, plus data storage, leaves a practical maximum
application size of around 1.5MB. Many applications already approach this
limit due to code overhead from the RTOS and communication stacks. Adding
support for additional protocols such as HTTPS and JSON parsing carries
significant tradeoffs on a device that do not exist on a server backend.

**Communication protocols are optimised for their specific constraints**

Device-to-platform communication protocols are chosen to suit the physical
environment — LoRa for long range and low power, BLE for short range,
MQTT for unreliable connections, and so on. Each involves tradeoffs between
bandwidth, power consumption, and reliability that are specific to the
device's situation. A server-to-server API, by contrast, operates over
reliable, high-bandwidth connections and can use standard HTTP without any
of these tradeoffs. Keeping device protocols optimised for their environment,
while standardising at the platform-to-platform layer, gives the best of
both worlds.

**Device data is often raw and requires off-device processing**

Many devices produce raw data that must be processed before it is meaningful
to a farmer. For example, a soil reflectometer may produce spectrographic
readings that require calibration and interpretation to produce actionable
values such as nitrogen or organic matter content. Due to the resource
constraints described above, this processing is typically performed off-device
by the Device-Platform. The presumption in this standard is that the device
builders — for example OurSci for their Reflectometer — are best placed to
perform this interpretation, and that it is the processed, meaningful values
that are communicated to the farmer's platform (e.g. LiteFarm), not the raw
instrument output.

---

## Annex E — [Title]

**(Normative | Informative)**

[TBD]