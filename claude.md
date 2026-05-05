# Frugal IoT Logger - Project Documentation

## Project Overview

**Frugal IoT Logger** is a Node.js-based MQTT listener and data forwarder for the Frugal IoT platform. It runs as a separate process that:

1. **Listens to MQTT topics** published by IoT devices
2. **Logs sensor data to disk** in CSV format for historical archival
3. **Forwards data to multiple backends**:
   - Firebase Realtime Database (for cloud storage and real-time sync)
   - Google Sheets (for spreadsheet analysis)
4. **Manages device schemas** and type conversions
5. **Deduplicates messages** using configurable rules
6. **Provides device schema generation** in W3C Web of Things format

The logger is designed to run independently from the web server and can be spawned by frugal-iot-server or run standalone.

## Technology Stack

- **Runtime**: Node.js with ES Modules
- **MQTT Client**: mqtt v5.15.0 (supports WebSocket connections)
- **Configuration**: js-yaml v4.1.1 (YAML parsing)
- **Async Control Flow**: async v3.2.6 (waterfall, series, each patterns)
- **Cloud Integration**:
  - Firebase Admin SDK v12.7.0 (Realtime Database)
  - Google Sheets HTTP API (via fetch)
- **Utilities**: array.prototype.tospliced v1.1.5 (Array splicing for Node 20+)

## Project Structure

```
frugal-iot-logger/
├── index.js                    # Main logger entry point (~1224 lines)
├── package.json                # Dependencies and project metadata
├── API.md                       # API specification for device platforms
├── README.md                    # Quick start guide
├── LICENSE                      # MIT License
├── examples/                    # Configuration examples
│   ├── firebase/               # Firebase example setup
│   │   ├── config.yaml
│   │   ├── firebase.js         # Standalone Firebase logger
│   │   ├── package.json
│   │   └── config.d/
│   │       ├── mqtt.yaml
│   │       ├── organizations/
│   │       │   ├── dev.yaml
│   │       │   └── varta.yaml
│   │       └── schema/
│   ├── gsheets/                # Google Sheets example setup
│   │   ├── config.yaml
│   │   ├── gsheets.js          # Standalone Gsheets logger
│   │   ├── package.json
│   │   └── config.d/
│   └── standalone/             # Disk-only logging example
│       ├── config.yaml
│       ├── standalone.js       # Disk logging example
│       └── config.d/
├── scripts/                     # Utility scripts
└── data/                        # Logged CSV data directory
    ├── {org}/
    │   ├── {project}/
    │   │   └── {device-id}/
    │   │       ├── {module}/
    │   │       │   ├── 2024-12-23.csv
    │   │       │   └── 2024-12-24.csv
    │   │       └── {another-module}/
```

## Key Components

### 1. **MqttLogger Class**
Main entry point for the logger system. Handles:
- Configuration loading from YAML files (config.yaml + config.d/)
- Instantiation of MqttOrganization clients
- Device schema generation in W3C Thing Descriptor format
- Command sending via MQTT

**Key Methods**:
- `start()` - Initiates MQTT connections for all configured organizations
- `readYamlConfig(path, callback)` - Reads hierarchical YAML configuration
- `getDeviceSchema(org, project, deviceId, baseURI)` - Returns W3C Thing Descriptor
- `sendCommand(org, project, deviceId, command, value)` - Sends command to device

### 2. **MqttOrganization Class**
Manages a single organization's MQTT connection and subscriptions. Each organization has:
- One MQTT broker connection
- Multiple projects and devices
- Per-topic deduplication rules
- Integration with Firebase and Google Sheets forwarders

**Key Methods**:
- `startClient()` - Establishes MQTT broker connection
- `configSubscribe()` - Sets up subscriptions based on config
- `messageReceived(date, topicPath, message)` - Handles incoming MQTT messages
- `shouldLog(date, topicPath, message)` - Applies filtering and deduplication
- `log(date, topic, message)` - Writes to CSV files
- `schemaModule(module)` - Returns schema for a module
- `schemaNode(nodeName)` - Returns schema for all modules on a node

### 3. **Forwarder Base Class**
Abstract base class for data forwarding backends:
- Firebase Realtime Database
- Google Sheets
- Custom integrations

Provides periodic tick-based forwarding (via `intervalSeconds` config).

### 4. **Firebase Class**
Forwards sensor data to Firebase Realtime Database with:
- **Latest values**: Updates `nodes/{nodeId}/latest/{sensorKey}`
- **History snapshots**: Pushes to `nodes/{nodeId}/history` periodically
- **Deduplication**: Skips writing if data hasn't changed since last write

**Key Methods**:
- `start()` - Initializes Firebase Admin SDK
- `writeData(date, topic, value)` - Updates latest sensor values
- `saveHistoryForAllNodes()` - Saves periodic snapshots
- `tick()` - Periodic timer callback

### 5. **Gsheet Class**
Forwards aggregated data to Google Sheets via HTTP POST.

**Key Methods**:
- `makeRow()` - Builds array of values from configured topics
- `tick()` - Sends batch update to Google Sheets API

## Configuration System

The logger uses hierarchical YAML configuration:

```
config.yaml                  # Main configuration
├── mqtt:                    # MQTT broker connection
│   broker: wss://...        # WebSocket URL for MQTT
├── schema:                  # Data schema definitions
│   modules: { ... }         # Module declarations
│   topics: { ... }          # Topic type definitions
└── organizations:           # Per-organization configs
    {org-id}:
      name: ...
      userid: ...
      mqtt_password: ...
      projects:
        {project-id}: { ... }
      firebase:               # Optional Firebase config
        serviceAccount: ...
        databaseURL: ...
        allowedNodes: [...]    # Filter nodes to forward
      gsheets:               # Optional Google Sheets config
        url: ...              # Webhook URL
        topics: [...]         # Topics to forward
        intervalSeconds: 300
```

### Configuration Hierarchy

Topics and modules can be overridden at multiple levels:
1. **Topic level** (config.d/schema/topics.yaml) - Base definition
2. **Module level** (config.d/schema/modules.yaml) - Module-specific override
3. **Organization level** - Organization-specific override
4. **Node/Project level** - Granular per-device override

## Message Processing Pipeline

```
MQTT Message
    ↓
[shouldLog checks]
  - Type validation (float, int, bool, text, etc.)
  - Topic depth validation
  - Legacy topic filtering
  - Log permission check (config field)
  ↓
[Deduplication]
  - Exact duplicates (same date + value)
  - Significant change rules
  ↓
[Storage]
  - CSV logging to disk
  - Firebase latest update
  - Firebase history batch (via tick)
  - Google Sheets batch (via tick)
```

## Data Types and Conversion

The `valueFromText()` function converts MQTT string messages:

- `bool` → Number (0/1)
- `int` → Number
- `float` → Number
- `text` → String
- `topic` → String
- `color` → String (hex)
- `yaml` → Parsed YAML object

## CSV Storage Format

Each sensor reading is stored as:
```
timestamp,"value"
1703318400000,"25.3"
1703318460000,"25.4"
```

All data is ISO date partitioned: `data/org/project/device/module/YYYY-MM-DD.csv`

## W3C Web of Things Thing Descriptor

The `getDeviceSchema()` method returns a complete Thing Descriptor per W3C specification:

```json
{
  "@context": [
    "https://www.w3.org/2022/wot/td/v1.1",
    {
      "frugal-iot": "https://frugaliot.naturalinnovation.org/ns/frugal-iot#"
    }
  ],
  "id": "dev/lotus/esp8266-fb94bb",
  "title": "ESP8266 Sensor Node",
  "base": "https://frugaliot.naturalinnovation.org",
  "properties": {
    "sht/temperature": {
      "type": "number",
      "title": "Temperature",
      "unit": "Cel",
      "minimum": -40,
      "maximum": 125,
      "readOnly": true,
      "frugal-iot:metadata": {
        "color": "#FF5733",
        "retain": true
      },
      "forms": [
        {
          "href": "/device/get?deviceId=dev/lotus/esp8266-fb94bb&key=sht/temperature",
          "contentType": "application/json",
          "op": "readproperty"
        }
      ]
    }
  },
  "actions": {
    "relay/on": {
      "title": "Relay 1",
      "input": {
        "type": "boolean"
      },
      "writeOnly": true,
      "forms": [
        {
          "href": "/device/command?deviceId=dev/lotus/esp8266-fb94bb&command=relay/on",
          "contentType": "application/json",
          "op": "invokeaction"
        }
      ]
    }
  }
}
```

### Thing Descriptor Features

- **@context**: Includes W3C WoT 1.1 and custom namespaces
- **Properties**: Read-only sensor fields with forms
- **Actions**: Writable control fields with input schemas
- **Forms**: HTTP and MQTT protocol bindings
- **frugal-iot:metadata**: Custom fields (color, slot, retain, log, duplicates rules)
- **Security**: Basic authentication scheme

## Coding Style Preferences

### Indentation
- **Use 2 spaces for indentation** (not tabs or 4 spaces)
- Apply consistently throughout all JavaScript files

### Asynchronous Code

The logger uses **async patterns** for compatibility with various Node.js versions:

1. **Callbacks (Legacy - still used in async.js patterns)**:
   ```javascript
   async.waterfall([
     (cb) => readFile(path, 'utf8', cb),
     (data, cb) => cb(null, yaml.load(data))
   ], (err, result) => {
     if (err) console.error(err);
   });
   ```

2. **Promises and async/await (Modern - used in Firebase/Command sending)**:
   ```javascript
   async sendCommand(org, project, deviceId, command, value) {
     return new Promise((resolve) => {
       // ... implementation ...
       resolve({ status: 'sent' });
     });
   }
   ```

3. **Event-driven (MQTT message handling)**:
   ```javascript
   this.mqtt_client.on('message', (topic, message) => {
     let msg = message.toString();
     this.dispatch(topic, msg);
   });
   ```

**Preference Order**:
- Use whichever pattern fits the context
- Callbacks (via async.js) for waterfall configuration loading
- Promises/async-await for Firebase operations
- Events for real-time MQTT subscriptions

## Development Notes

### Starting the Logger (Standalone)

```bash
npm install
node index.js
```

Expected startup output:
- Configuration files read
- MQTT connections initialized per organization
- Firebase connections configured
- Google Sheets webhooks registered
- Logger listening to MQTT topics

### Running with Custom Config Path

```bash
# If embedded in another project
import { MqttLogger } from './index.js';

const logger = new MqttLogger();
logger.readYamlConfig('./config', (err, config) => {
  if (err) {
    console.error('Config error:', err);
  } else {
    logger.start();
  }
});
```

### Logger as Service

In frugal-iot-server, the logger is typically spawned:

```javascript
const logger = new MqttLogger();
logger.readYamlConfig(configPath, (err, config) => {
  if (err) throw err;
  logger.start();
});
```

## Deduplication Rules

Messages can be filtered based on `duplicates` configuration at any level:

```yaml
duplicates:
  significantdate: 60000    # Skip if within 60 seconds
  significantvalue: 0.5     # Skip if value change < 0.5
```

If **both** rules are specified, message is skipped if **neither** condition is met.

## Firebase Integration

### Configuration

```yaml
firebase:
  serviceAccount: ./firebase-service-account.json
  databaseURL: https://project-rtdb.region.firebasedatabase.app
  allowedNodes:
    - dev/lotus/esp8266    # Prefix match or exact node ID
    - esp8266-fb94bb
  intervalSeconds: 300
  verbose: true
```

### Data Structure

```
nodes/
├── esp8266-fb94bb/
│   ├── latest/                    # Updated on every message
│   │   ├── sht_temperature: 25.3
│   │   ├── sht_humidity: 65.2
│   │   └── timestamp: 1703318460000
│   └── history/
│       ├── -O3sK2jF.../           # Push IDs
│       │   ├── sht_temperature: 25.3
│       │   ├── sht_humidity: 65.2
│       │   └── timestamp: 1703318460000
│       └── -O3sK2jG.../
```

## Google Sheets Integration

### Configuration

```yaml
gsheets:
  url: https://script.google.com/macros/d/{scriptId}/userweb
  sheet: "Sheet1"
  topics:
    - "dev/lotus/esp8266-fb94bb/sht/temperature"
    - "dev/lotus/esp8266-fb94bb/sht/humidity"
  intervalSeconds: 300
```

### Data Format

Each tick sends:
```json
{
  "sheet": "Sheet1",
  "row": ["2025-07-25T10:20:01", 25.3, 65.2]
}
```

## Common Development Tasks

### Adding a New Organization

1. Create `config.d/organizations/{org}.yaml`
2. Add projects and MQTT credentials
3. Optionally add Firebase config
4. Restart logger

### Adding a New Sensor Type

1. Update `config.d/schema/topics.yaml` with new topic
2. Define type (float, int, bool, text, etc.)
3. Set `rw` (read-only = "r", writable = "w")
4. Add to module definition in `config.d/schema/modules.yaml`
5. Data automatically logged and forwarded

### Debugging Device Issues

Enable verbose logging:

```yaml
firebase:
  verbose: true
```

Check CSV files:
```bash
ls -la data/{org}/{project}/{device-id}/{module}/
cat data/{org}/{project}/{device-id}/{module}/2024-12-23.csv
```

### Sending Commands to Devices

```javascript
const result = await logger.sendCommand('dev', 'lotus', 'esp8266-fb94bb', 'relay/on', true);
console.log(result); // { status: 'sent', message: '...' }
```

## Related Projects

- **frugal-iot-server** - Web server that manages this logger
- **frugal-iot-client** - UI client for the web server
- **frugal-iot** - Embedded device platform that publishes MQTT messages
- **Firebase** - Cloud database backend (optional)
- **MQTT Broker** - Mosquitto or equivalent

## Security Considerations

- MQTT connections use WSS (WebSocket Secure) in production
- Firebase credentials stored in JSON file (keep secret) and do not add to GIT
- Google Sheets webhook URLs should use authentication
- Device commands validated against schema (type, min/max, rw permissions)
- Organization isolation enforced in MQTT subscriptions

## Performance Notes

- CSV data stored on disk for scalability
- Firebase updates are non-blocking (callback-based)
- Google Sheets batches updates periodically (not on every message)
- Deduplication significantly reduces Firebase writes
- Memory usage is minimal (only maintains latest value per device)

## Known Limitations

1. Single Firebase app per process (admin SDK limitation)
2. No built-in data compression for long-term CSV storage
3. Google Sheets requires valid webhook URL
4. MQTT credentials stored in YAML (should ideally use secrets manager)
5. Message ordering not guaranteed with async forwarders

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| MQTT Connection Failed | Broker URL incorrect or offline | Check `config.d/mqtt.yaml` and broker status |
| Firebase Write Errors | Wrong credentials or no network | Verify service account JSON and network access |
| Data Not Logging | Topic doesn't match config | Ensure topic in schema and log flag is true |
| Google Sheets Not Updating | Webhook URL invalid or network issue | Test webhook URL, enable verbose mode |
| High Memory Usage | Too many devices or old Node.js | Disable verbose logging, upgrade Node.js |

## Future Enhancements

- TODO-8: Rework findMostGranular to support nested organization structures
- Add timezone support for CSV date partitioning
- Implement comprehensive error recovery for forwarders
- Add metrics/monitoring endpoint
- Support for additional backends (InfluxDB, TimescaleDB, etc.)
- Built-in data compression for historical CSV files

