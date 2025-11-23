# Firebase Integration - Complete Guide

## Overview

This Firebase integration automatically uploads MQTT sensor data to Firebase Realtime Database, providing cloud storage and easy access from web/mobile apps.

**How data is saved:**
- **latest/** - Updated immediately when ANY sensor sends data (real-time)
- **history/** - Saved periodically (default: every 60 seconds) as snapshots of ALL sensors

## Quick Start

### 1. Setup Firebase

1. Go to https://console.firebase.google.com/
2. Create/select your project
3. Enable Realtime Database (test mode for now)
4. Note your database URL: `https://your-project.firebaseio.com`
5. Download service account key:
   - Settings → Service Accounts → Generate New Private Key
   - Save as `firebase-service-account.json`

### 2. Configure

Edit `examples/firebase/config.d/organizations/dev.yaml`:

```yaml
firebase:
  serviceAccount: ./firebase-service-account.json
  databaseURL: https://your-project.firebaseio.com
  verbose: false
  trackLatest: true
  allowedNodes:
    - esp32-6c5e0e
    - esp32-3c7ab8
```

### 3. Run

```bash
cd examples/firebase
npm install
npm start
```

## Supported Data Types

Firebase integration supports all sensor data types:

- **Numbers**: Temperature (25.3), humidity (43.2), soil moisture (450)
- **Booleans**: Relay states (true/false), on/off indicators
- **Strings**: Text data, status messages
- **Objects/Arrays**: Complex data structures

Invalid values (undefined, null, NaN, Infinity) are automatically skipped.

## Firebase Data Structure

### Simple Structure
```
nodes/
  esp32-6c5e0e/
    latest/
      sht_humidity: 43.3
      sht_temperature: 15.1
      ds18b20_ds18b20: 16.0
      soil_soil: 1
      timestamp: 1763136945390
      date: "2025-11-14T16:15:45.390Z"
    
    history/
      -N1234abc:
        sht_humidity: 43.3
        sht_temperature: 15.1
        ds18b20_ds18b20: 16.0
        soil_soil: 1
        timestamp: 1763136945390
        date: "2025-11-14T16:15:45.390Z"
        trigger: "sht_humidity"
```

### Data Explanation

**latest/** - Current state of all sensors
- Single object that gets overwritten
- Contains all sensor values
- Updated immediately whenever ANY sensor changes

**history/** - Time-series snapshots
- New entry added on a schedule (e.g., every 60 seconds)
- Contains ALL sensor values at that moment
- One write per interval (efficient!)
- Useful for tracking trends over time

## Configuration Options

### Required
- `serviceAccount` - Path to Firebase service account JSON
- `databaseURL` - Your Firebase Realtime Database URL

### Optional
- `verbose` (default: false) - Log each Firebase write
- `trackLatest` (default: false) - Maintain latest values
- `historyIntervalSeconds` (default: 60) - How often to save history snapshots
- `allowedNodes` (default: all) - Whitelist specific nodes

### Example Configuration

```yaml
firebase:
  serviceAccount: ./firebase-service-account.json
  databaseURL: https://varta-gdt-default-rtdb.asia-southeast1.firebasedatabase.app
  verbose: false
  trackLatest: true

  allowedNodes:
    - esp32-6c5e0e
    - esp32-3c7ab8
```

## Node Filtering

Only save data from specific nodes to reduce Firebase usage:

```yaml
firebase:
  allowedNodes:
    - esp32-6c5e0e  # Only these nodes
    - esp32-3c7ab8  # will save to Firebase
```

**Without `allowedNodes`**: All nodes save to Firebase  
**With `allowedNodes`**: Only listed nodes save to Firebase

## De-duplication Settings

Control how often data is saved by adjusting de-duplication rules:

```yaml
developers:
  name: Developers
  nodes:
    +:
      sub:
        sht:
          topics:
            humidity:
              type: float
              duplicates:
                significantdate: 60000      # 60 seconds
                significantvalue: 0.1       # 0.1 change
```

**significantvalue**: Minimum change to save (e.g., 0.1 = save if change >= 0.1)  
**significantdate**: Minimum time between saves in milliseconds

## Querying Data

### Get Latest Values (JavaScript)

```javascript
import { getDatabase, ref, onValue } from 'firebase/database';

const db = getDatabase();
const latestRef = ref(db, 'nodes/esp32-6c5e0e/latest');

onValue(latestRef, (snapshot) => {
  const data = snapshot.val();
  console.log('Temperature:', data.sht_temperature);
  console.log('Humidity:', data.sht_humidity);
  console.log('Last update:', new Date(data.timestamp));
});
```

### Get History (JavaScript)

```javascript
import { getDatabase, ref, query, orderByChild, limitToLast } from 'firebase/database';

const db = getDatabase();
const historyRef = ref(db, 'nodes/esp32-6c5e0e/history');
const recentQuery = query(historyRef, orderByChild('timestamp'), limitToLast(10));

onValue(recentQuery, (snapshot) => {
  snapshot.forEach((child) => {
    const data = child.val();
    console.log(`${data.date} (triggered by ${data.trigger}):`);
    console.log(`  Temp: ${data.sht_temperature}, Humidity: ${data.sht_humidity}`);
  });
});
```

### Get Time Range (JavaScript)

```javascript
const oneHourAgo = Date.now() - (60 * 60 * 1000);
const historyRef = ref(db, 'nodes/esp32-6c5e0e/history');
const timeQuery = query(historyRef, orderByChild('timestamp'), startAt(oneHourAgo));

onValue(timeQuery, (snapshot) => {
  snapshot.forEach((child) => {
    const data = child.val();
    // Process data
  });
});
```

## How It Works

### Data Flow

```
Sensor sends data
  ↓
MQTT Broker
  ↓
Logger receives
  ↓
De-duplication check
  ↓
Update internal cache (all sensors)
  ↓
Write to Firebase:
  ├─ latest/ (overwrite with all current values)
  └─ history/ (push new snapshot with all values)

```

### When Sensor Updates

1. **Sensor sends**: `dev/developers/esp32-6c5e0e/sht/humidity` = `43.3`
2. **Logger updates cache**: Stores new humidity value
3. **Updates Firebase latest**: All sensor values (new humidity + old temp/soil/etc)
4. **History saved on timer**: Every 60 seconds, saves snapshot of ALL sensors

### Example Sequence

```
Time 0:00 - Humidity arrives (43.3)
  latest: { sht_humidity: 43.3 }

Time 0:05 - Temperature arrives (15.1)
  latest: { sht_humidity: 43.3, sht_temperature: 15.1 }

Time 0:10 - DS18B20 arrives (16.0)
  latest: { sht_humidity: 43.3, sht_temperature: 15.1, ds18b20_ds18b20: 16.0 }

Time 0:15 - Soil arrives (1)
  latest: { sht_humidity: 43.3, sht_temperature: 15.1, ds18b20_ds18b20: 16.0, soil_soil: 1 }

Time 1:00 - Timer triggers (60 seconds)
  history: { sht_humidity: 43.3, sht_temperature: 15.1, ds18b20_ds18b20: 16.0, soil_soil: 1 }

Time 1:30 - Humidity changes (43.6)
  latest: { sht_humidity: 43.6, sht_temperature: 15.1, ds18b20_ds18b20: 16.0, soil_soil: 1 }

Time 2:00 - Timer triggers (60 seconds)
  history: { sht_humidity: 43.6, sht_temperature: 15.1, ds18b20_ds18b20: 16.0, soil_soil: 1 }
```

## Troubleshooting

### No data in Firebase?

**Check 1**: Is the logger running?
```bash
cd examples/firebase
npm start
```

**Check 2**: Are sensors sending 4+ part topics?
- ✅ Good: `dev/developers/esp32-6c5e0e/sht/humidity`
- ❌ Bad: `dev/developers` (quickdiscover only)

**Check 3**: Is node in allowedNodes?
```yaml
allowedNodes:
  - esp32-6c5e0e  # Make sure your node is listed
```

**Check 4**: Enable verbose logging
```yaml
firebase:
  verbose: true  # See what's happening
```

### Data not updating?

**Cause**: De-duplication filtering small changes

**Solution**: Lower significantvalue
```yaml
duplicates:
  significantvalue: 0.1  # Save if change >= 0.1
```

### "Permission denied" error?

**Cause**: Firebase security rules blocking writes

**Solution**: Use test mode rules (Firebase Console → Database → Rules):
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

## Security

### Test Mode (Development)
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

### Production Mode
```json
{
  "rules": {
    "nodes": {
      "$nodeId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

### Service Account Security
- Keep `firebase-service-account.json` secure
- Never commit to git
- Add to `.gitignore`

## Performance & Costs

### Firebase Free Tier
- 1GB storage
- 10GB/month download
- 100 simultaneous connections

### Typical Usage
- Latest updates: 4 sensors × 1 update/minute = 4 writes/minute
- History snapshots: 1 write/minute (all sensors together)
- Total: ~5 writes/minute
- ~7,200 writes/day
- ~200 bytes per write
- ~1.4 MB/day storage

### Optimization Tips
1. Use `allowedNodes` to filter unnecessary devices
2. Adjust `significantvalue` to reduce writes
3. Set up cleanup for old history data
4. Use `latest` for dashboards (no history queries)

## Example Project Structure

```
examples/firebase/
├── firebase.js                          # Startup script
├── package.json                         # Dependencies
├── config.yaml                          # Main config
├── config.d/
│   ├── mqtt.yaml                        # MQTT broker
│   └── organizations/
│       └── dev.yaml                     # Org config with Firebase
└── firebase-service-account.json        # Your credentials (gitignored)
```

## Complete Configuration Example

```yaml
# examples/firebase/config.d/organizations/dev.yaml
mqtt_password: public
name: Development

firebase:
  serviceAccount: ./firebase-service-account.json
  databaseURL: https://your-project.firebaseio.com
  verbose: false
  trackLatest: true
  allowedNodes:
    - esp32-6c5e0e

projects:
  developers:
    name: Developers
    nodes:
      +:
        sub:
          sht:
            topics:
              humidity:
                type: float
                duplicates:
                  significantdate: 60000
                  significantvalue: 0.1
              temperature:
                type: float
                duplicates:
                  significantdate: 60000
                  significantvalue: 0.1
          ds18b20:
            topics:
              ds18b20:
                type: float
                duplicates:
                  significantdate: 60000
                  significantvalue: 0.1
          soil:
            topics:
              soil:
                type: int
                duplicates:
                  significantdate: 60000
                  significantvalue: 1
```

## Deep Sleep Device Support

The system automatically handles devices that go into deep sleep (e.g., active for 5 minutes, sleep for 1 hour):

**How it works:**
- When device is awake: Sends MQTT messages → Firebase updates normally
- When device is asleep: No MQTT messages → No Firebase updates
- Timer still runs but detects no data changes → Skips duplicate history writes
- When device wakes up: Resumes sending data → Firebase updates resume automatically

**No special configuration needed!** The logger automatically detects when data hasn't changed and skips writing duplicate history entries. This saves Firebase writes and costs during sleep periods.

**Example with verbose logging:**
```
Firebase history saved: esp32-6c5e0e (4 sensors)
Firebase history saved: esp32-6c5e0e (4 sensors)
Firebase history skipped (no change): esp32-6c5e0e  ← Device went to sleep
Firebase history skipped (no change): esp32-6c5e0e  ← Still sleeping
Firebase history skipped (no change): esp32-6c5e0e  ← Still sleeping
Firebase history saved: esp32-6c5e0e (4 sensors)    ← Device woke up, new data
```

## Key Features

✅ Real-time cloud storage  
✅ Simple structure: `nodes/{nodeId}/latest` and `history`  
✅ Automatic snapshots with all sensor values  
✅ Smart duplicate detection (no writes during deep sleep)  
✅ Node filtering to control costs  
✅ De-duplication to reduce writes  
✅ Easy querying from web/mobile apps  
✅ Works with any sleep pattern (no configuration needed)  


