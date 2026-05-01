// noinspection JSAssignmentUsedAsCondition,JSUnresolvedReference

/*
 * Basic Logger for the Frugal IoT project
 *
 * Intended to be run as part of an HTTP server but could be run standalone
 *
 */

import async from 'async'; // https://caolan.github.io/async/v3/docs.html
import yaml from 'js-yaml'; // https://www.npmjs.com/package/js-yaml
import { appendFile, mkdir, readFile, readdir } from "fs"; // https://nodejs.org/api/fs.html
import mqtt from 'mqtt'; // https://www.npmjs.com/package/mqtt
import admin from 'firebase-admin'; // Firebase Admin SDK
//import tospliced from 'array.prototype.tospliced'; // tospliced only in Node > 20 (and webstorm currently 18)

// =======
// Ignore any of these legacy topic - should go away when MQTT memory next cleared as not in any current device
// Still there as of 2026-02-24
// Note - not being in this list should not be a problem - it will be ignored since type not found
const legacytopics = ["wifistrength", "state", "co2", "auto", "reboot", "temp_setpoint", "temp_hysteresis", "temp_out"];
const legacymodules = ["blinken_out","messages", "now"];

// =========== Some generic helper functions, not specific to this client ========
// Clean any leading "/" or "../" from a string so it can be safely appended to a path
function sanitizeUrl(t) {
  if(t && t[0] === '/') { return sanitizeUrl(t.substring(1)); }
  return (t.replaceAll("../",""));
}
// A place to put a breakpoint
function XXX(args) {
  if (args) {
    if (typeof(args) === 'string') {
      console.log(args);
    } else {
      console.log(...args);
    }
  }
  return false;
}

// TODO-8 rework this,
// Currently specific to structure of config.d/organizations/*yaml
// Allow overrides in config.d/organizations/*yaml but simplify to look like modules or topics
function findMostGranular(o, topicPathArray, f) {
  let n = topicPathArray[0]  // current segment may be undefined but shouldn't be
  if (topicPathArray.length > 1) {
    let topicRestArray = topicPathArray.toSpliced(0,1); // If this fails, you are running on an old (<20) version of node
    let oo = o.projects || o.nodes || o.sub // Next step depends on if org, project, node or topic
    // Recurse on remaining path, note always want the deepest possible
    return (
      oo && (
        (oo[n] && findMostGranular(oo[n], topicRestArray, f))
        || (oo['+'] && findMostGranular(oo['+'], topicRestArray, f))
      ));
  } else { // We are at the leaf, no more path, so look for n.field
    let oo = o.topics // Next step depends on if org, project, node or topic
    return (
      ((typeof (f) === 'string') && oo[n] && oo[n][f])
      || ((typeof (f) === 'function') && oo[n] && f(oo[n])) // f is never currerntly a function (Feb2026)
    );
  }
}

function isDuplicate(date, topic, value, rules, lastdate, lastvalue) {
  if (rules) {
    let ld = lastdate || 0;
    let lv = lastvalue || 0;
    if ((date === ld) && (value === lv)) return true; // Eliminate any exact duplicates
    if (rules.significantvalue && (Math.abs(value - lv) >= rules.significantvalue)) { return false; }
    if (rules.significantdate && ((date-ld) >= rules.significantdate)) { return false; }
    if (rules.significantdate || rules.significantvalue) { return true; } // Conditions but didn't meet any of them
  }
  return false; // No conditions or no rules (e.g. for discovery at org/project=node
}
// NOTE same function in frugal-iot-logger and frugal-iot-client if change here, change there
function valueFromText(message, type) {
  switch(type) {
    case "bool":
      if (message === "true") return 1;
      if (message === "false") return 0;
      return Number(message); // Message "0" or "1" and want to store number anyway
    case "float":
      return Number(message)
    case "int":
      return Number(message)
    case "topic":
      return message;
    case "text":
      return message;
    case "color":
      return message; // TODO should ideally convert to a rgb hex so can log
    case "yaml":
      // noinspection JSUnusedGlobalSymbols
      return yaml.load(message, {onWarning: (warn) => console.log('Yaml warning:', warn)});
    default:
      XXX(`Unrecognized message type: ${type}`);
      return undefined;
  }
}
// Class with one object per subscription including de-duplication rules.
// Subscriptions are held under the Organization level, and can include wild-card subscriptions.
class Subscription {
  constructor(topic, qos, cb) {
    this.topic = topic;
    this.qos = qos;
    this.cb = cb;
  }
  matches(topic) {
    if (this.topic.includes('+')) {
      function m(x, y) {
        return (x === y) || (y === '+')
      }

      let [o, p, n, t, pp] = topic.split('/');
      let [os, ps, ns, ts, pps] = this.topic.split('/');
      return m(o, os) && m(p, ps) && m(n, ns) && m(t, ts) & m(pp, pps);
    } else if (this.topic.endsWith('#')) {
      return topic.startsWith(this.topic.substring(0,this.topic.length-1))
    } else {
      return this.topic === topic;
    }
  }
  dispatch(topic, message) {
    // Dispatch, duplicate checking done on MqttOrganization.dispatch
    let date = new Date();
    this.cb(date, topic, message);
  }

}
// ================== MQTT Client embedded in server ========================

// Manages a connection to a broker - each organization needs its own connection
class MqttOrganization {
  constructor(id, config_org, config_mqtt, config_schema) {
    this.id = id;
    this.config_org = config_org; // Config structure currently: { name, mqtt_password, projects: { id: { topics: { temperature , humidity }
    this.config_mqtt = config_mqtt; // { broker }
    this.config_schema = config_schema; // { topics, modules }
    this.mqtt_client = null; // Object from library
    // noinspection JSUnusedGlobalSymbols
    this.status = "constructing"; // Note that the status isn't currently available anywhere
    this.projects = {};
    this.subscriptions = [];
    this.gsheets = [];
    this.firebases = [];
    this.currentValue = {}
    this.lastDate = {};
    this.lastValue = {};
    }

  mqtt_status_set(k) {
    console.log('mqtt', this.id, k);
    this.status = k;
  }

  startClient() {
    if (!this.mqtt_client) {
      // See https://stackoverflow.com/questions/69709461/mqtt-websocket-connection-failed
      this.mqtt_status_set("connecting");
      // noinspection JSUnresolvedReference
      this.mqtt_client = mqtt.connect(this.config_mqtt.broker, {
        // Options documented at https://www.npmjs.com/package/mqtt#Client
        connectTimeout: 5000,
        username: this.config_org.userid || this.id,
        password: this.config_org.mqtt_password,
      });
      this.mqtt_client.on("connect", () => {
        this.mqtt_status_set('connect');
        this.configSubscribe();
        this.gsheetsSubscribe();
        this.firebaseSubscribe();
      });
      this.mqtt_client.on("reconnect", () => {
        this.mqtt_status_set('reconnect');
        this.resubscribe();
      });
      for (let k of ['disconnect', 'close', 'offline', 'end']) {
        this.mqtt_client.on(k, () => {
          this.mqtt_status_set(k);
        });
      }
      this.mqtt_client.on('error', (error) => {
        this.mqtt_status_set("Error:" + error.message);
      });
      this.mqtt_client.on("message", (topic, message) => {
        // message is Buffer
        let msg = message.toString();
        console.log("Received", topic, " ", msg);
        this.dispatch(topic, msg);
      });
    }
  }

  subErr(err, val) {
    if (err) {
      console.log("Subscription failed", val, err);
    }
  }

  mqtt_subscribe(topic, qos) {
    console.log("Subscribing topic", topic, qos);
    this.mqtt_client.subscribe(topic, {qos: qos}, this.subErr);
  }

  subscribe(topic, qos, cb) {
    this.mqtt_subscribe(topic, qos);
    this.subscriptions.push(new Subscription(topic, qos, cb));
  }
  quickdiscover(date, topic, message) {
    // Save a record of a quickdiscover message so we know when last seen
    // topic = "orgid/projectid"  message = "nodeid"
    let pid = topic.split('/')[1];
    let nid = message;
    if (!this.projects[pid]) { this.projects[pid] = {}; }  // Make sure a projects obj exists
    //console.log("XXX client11",pid,nid,date)
    this.projects[pid][nid] = date; // Record last time we saw this node
  }
  // noinspection JSUnusedLocalSymbols
  watchProject(pid, p) {
    // Things to do regarding the project, other than subscribing based on config
    // Watch for quickdiscover messages and record last time node seen
    this.subscribe(`${this.id}/${pid}`, 0, this.quickdiscover.bind(this));
  }
  configSubscribe() {
    // noinspection JSUnresolvedReference
    if (this.subscriptions.length === 0) { // connect is called after onReconnect - do not re-add subscriptions
      let o = this.config_org;
      this.subscribe(`${this.id}/#`, 0, this.messageReceived.bind(this));
      for (let [pid, p] of Object.entries(o.projects)) {
        this.watchProject(pid, p);
        // Subscribe to everything on this organization - probably quicker than throwing stuff away
      }
    }
  }
  resubscribe() {
    for (let sub of this.subscriptions) {
      this.mqtt_subscribe(sub.topic, sub.qos);
    }
  }
  dispatch(topic, message) {
    this.subscriptions.filter(s => s.matches(topic)).forEach(s => s.dispatch(topic, message));
  }

  schemaField(module, leaf, field) {
    let moduleSchema = this.config_schema.modules[module];
    let moduleTopicSchema = moduleSchema && moduleSchema.topics.find(t => (t.leaf === leaf));
    let topicLeaf = (moduleTopicSchema && moduleTopicSchema["leaf_from"]) || leaf; // Always exists - at worst, if no module, its leaf directly to topics
    let topicSchema = this.config_schema.topics[topicLeaf];
    // Check for override in the module schema, otherwise from topic schema
    return ((moduleTopicSchema && moduleTopicSchema[field]) || (topicSchema && topicSchema[field])); // could be undefined
  }
  // Search various places in priority order to get value for a field -
  // This allows organizations to override modules override topics override default
  findMostGranular(topicPathArray, field, def) { // topicPathArray = [ project, node, module, leaf ]
    return findMostGranular(this.config_org, topicPathArray, field)
      || this.schemaField(topicPathArray[2], topicPathArray[3], field)
      || def;
  }
  // Check if should log this message
  shouldLog(date, topicPath, message) { // note message is string at this point
    // Discard messages too deep (or "set")
    let typesToLog = [ "float", "int", "bool" ]; // By default log these types
    let topicPathArray = topicPath.split('/');  // [ org, project, node, [ set ], module, leaf, [ parm ]
    // We are inside the organization so already handled first field
    topicPathArray.shift(); // [ project, node, [ set ], module, leaf, [ parm ]
    if (topicPathArray.length <4) {
      //console.log("XXX rejecting message with too few", topicPath);
      return false;
    } // Not logging parms

    // Can ignore "set"
    if (topicPathArray[2] === "set") {
      //console.log("XXX rejecting set in", topicPath);
      // LEGACY - see https://github.com/mitra42/frugal-iot-logger/issues/17
      // Remove the "set" from the path so it can match the schema
      // This is a legacy workaround for old devices that publish to "org/project/node/set/module/leaf" and don't echo back "org/project/node/module/leaf"
      // Its particularly needed for relay/on
      //topicPathArray.splice(2,1);
      return false;
    } // If change this, will need to snip the "set" out the array
    if (legacymodules.includes(topicPathArray[2]) || legacytopics.includes(topicPathArray[3])) {
      //console.log("XXX rejecting legacy in", topicPath);
      return false;
    }
    if (topicPathArray.length > 4) {
      //console.log("XXX rejecting message with parameters", topicPath);
      return false;
    } // Not logging parms
    // Find most granular type
    let type = this.findMostGranular(topicPathArray, "type", undefined);
    let value = valueFromText(message, type);
    // Save the current value whether logging or not
    this.currentValue[topicPath] = value;
    // Find most granular rw
    let rw = this.findMostGranular(topicPathArray, "rw");
    // Find most granular log - but generic type-specific rule if not found
    let log = this.findMostGranular(topicPathArray, "log", (typesToLog.includes(type) && rw === "r"));
    if (!log) {
      //console.log("XXX rejecting topic flagged !log", topicPath);
      return false;
    }
    // Get the duplicate rules
    let duplicates = this.findMostGranular(topicPathArray, "duplicates", undefined);
    if (isDuplicate(date, topicPath, value, duplicates, this.lastDate[topicPath], this.lastValue[topicPath])) {
      //console.log("XXX rejecting duplicate", topicPath, message);
      return false;
    }
    // Keep a value that can be compared for duplicates.
    // Note, this is different from cyrrentValue as its the last value logged, not the last value reported.
    this.lastValue[topicPath] = value;
    this.lastDate[topicPath] = date;
    return true;
  }

  // Setup by configSubscribe
  messageReceived(date, topicPath, message) {
    if (this.shouldLog(date, topicPath, message)) {
      this.log(date, topicPath, message);
    }
      // Send to all Firebase instances if configured - Google sheets doesnt do anything at the per-message level
      // TODO-8 this should really be a generic forwarder function, that does nothing for Gsheets
      if (this.firebases.length > 0) {
        // Find the current value, already converted and saved above
        let value = this.currentValue[topicPath] || message;
        // Pass only value (not message) - message is raw string, value is parsed/typed
        // Filtering by allowedNodes happens inside writeData for each instance
        for (let fb of this.firebases) {
          fb.handleMessage(date, topicPath, value);
        }
      }
  }
  log(date, topic, message) {
    let path = `data/${sanitizeUrl(topic)}`;
    let filename = `${date.toISOString().substring(0, 10)}.csv`
    this.appendPathFile(path, filename, `${date.valueOf()},"${message}"\n`);
  }
  appendPathFile(path, filename, message) {
    mkdir(path, {recursive: true}, (err/*, val*/) => {
      if (err) {
        console.error(err);
      } else {
        appendFile(path + "/" + filename, message, (err) => {
          if (err) console.log(err);
        });
      }
    })
  }
  gsheetsSubscribe() {
    if (this.gsheets.length === 0) { // connect is called after onReconnect - do not re-add subscriptions
      let o = this.config_org;
      if (o.gsheets) {
        for (let gsconfig of o.gsheets) {
          let gs = new Gsheet(gsconfig, this);
          this.gsheets.push(gs);
          gs.start();
        }
      }
    }
  }
  // Starting with a topic return the current value of the topic - for periodic forwarders.\
  findLastValue(topic) {
    return this.currentValue[topic];
  }

  // Initialize Firebase integration if configured in the organization's YAML config
  // Pattern matches gsheetsSubscribe - supports multiple Firebase instances
  firebaseSubscribe() {
    if (this.firebases.length === 0) { // connect is called after onReconnect - do not re-add subscriptions
      let o = this.config_org;
      if (o.firebase) {
        // Support both single config object and array of configs
        const configs = Array.isArray(o.firebase) ? o.firebase : [o.firebase];
        for (let fbconfig of configs) {
          let fb = new Firebase(fbconfig, this);
          this.firebases.push(fb);
          fb.start();
        }
      }
    }
  }
  // Linear time remap of values to avoid n^2 search for reportNodes
  reportNodes() {
    let res = {};
    let reportLeafs = [
      "frugal_iot/description",
      "frugal_iot/name",
      "ota/key",
    ];
    Object.entries(this.currentValue).forEach(([key, value]) => {
      let [ orgid, projectid, nodeid, moduleid, leaf, rest ] = key.split('/');
      let ml;
      if (!rest && reportLeafs.includes(ml = `${moduleid}/${leaf}`)) {
        let p = (res[projectid] || (res[projectid] = {}));
        let n = (p[nodeid] || (p[nodeid] = {}));
        n[ml] = value;
      }
    });
    Object.entries(this.projects).forEach(([projectid, proj]) => {
      Object.entries(proj).forEach(([nodeid, lastseen]) => {
        res[projectid][nodeid]['lastseen'] = lastseen;
      });
    });
    return res;
  }
}  // MqttOrganization

// ================== Forwarder - base class for Firebase, Gsheet, etc. ========================
class Forwarder {
  constructor(config, org) {
    this.config = config;
    this.org = org;
    this.periodicTimer = null;
    this.initialized = false;
  }

  start() {
    if (this.config.intervalSeconds) {
      // If intervalSeconds unset,skip the tick() functionality
      this.periodicTimer = setInterval(this.tick.bind(this), this.config.intervalSeconds * 1000);
    }
    this.initialized = true;
    // Subclasses will add to this.
  }
  // Clean up resources when stopping - not currently used
  stop() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    this.initialized = false;
  }
  makeRow() {
    // Set up an array with the values of the topics we are monitoring in the same order as in the configuration
    return this.config.topics
      .map((topic) => this.org.findLastValue(topic));
  }
  handleMessage(date, topic, message) {
    // Default does nothing - subclasses can override if needed
  }
}
// ================== Firebase Integration ========================
class Firebase extends Forwarder {
  constructor(config, org) {
    super(config, org);
    this.db = null;
    // Store latest values for each node to create snapshots
    this.nodeLatestValues = {}; // { nodeKey: { topicKey: value } } - simplified structure
    // Track last written history to avoid duplicates when nodes are asleep
    this.lastWrittenHistory = {}; // { nodeKey: JSON string of last history data }
  }

  start() {
    try {
      // Initialize Firebase Admin SDK
      // Note: Only one Firebase app can be initialized per process
      // If multiple orgs need Firebase, they should share the same project or use named apps
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(this.config.serviceAccount),
          databaseURL: this.config.databaseURL
        });
      }
      this.db = admin.database();
      console.log('Firebase initialized for org:', this.org.id);
      super.start(); // Start timer

    } catch (error) {
      console.error('Firebase initialization failed:', error);
    }
  }
  
  saveHistoryForAllNodes() {
    // Save history snapshot for each node that has data
    for (const [nodeKey, sensorData] of Object.entries(this.nodeLatestValues)) {
      const sensorCount = Object.keys(sensorData).length;
      if (sensorCount === 0) continue;
      
      // Extract nodeId from nodeKey (format: "org/project/node")
      const nodeId = nodeKey.split('/')[2];
      const nodePath = `nodes/${nodeId}`;
      
      // Changed: Simplified history data creation using spread operator
      // Previously had to loop and extract .value from each sensor
      // Now sensorData directly contains values, so just copy it
      const historyData = {...sensorData};
      
      // Check if data has changed since last write (prevents duplicate writes during deep sleep)
      const historyDataString = JSON.stringify(historyData);
      if (this.lastWrittenHistory[nodeKey] === historyDataString) {
        // Data hasn't changed - skip writing duplicate
        // This saves Firebase writes when devices are in deep sleep
        if (this.config.verbose) {
          console.log('Firebase history skipped (no change):', nodeId);
        }
        continue;
      }
      
      // Data has changed - add timestamp and save
      // Note: ISO date string can be derived client-side: new Date(timestamp).toISOString()
      historyData.timestamp = Date.now();

      this.db.ref(`${nodePath}/history`).push(historyData, (err) => {
        if (err) {
          console.error('Firebase history write error:', err);
        } else {
          this.lastWrittenHistory[nodeKey] = historyDataString;
          if (this.config.verbose) {
            console.log('Firebase history saved:', nodeId, `(${sensorCount} sensors)`);
          }
        }
      });
      /*
      // Save to Firebase
      this.db.ref(`${nodePath}/history`).push(historyData)
        .then(() => {
          // Update last written history after successful write
          this.lastWrittenHistory[nodeKey] = historyDataString;
          if (this.config.verbose) {
            console.log('Firebase history saved:', nodeId, `(${sensorCount} sensors)`);
          }
        })
        .catch((error) => {
          console.error('Firebase history write error:', error);
        });

       */
    }
  }
  tick() {
    this.saveHistoryForAllNodes();
  }
  // Write MQTT data to Firebase Realtime Database
  // Changed: Removed 'message' parameter - only 'value' is needed (message was never used)
  writeData(date, topic, value) {
    if (!this.initialized) return;

    try {
      // Parse topic: org/project/node/topic or org/project/node/subtopic/topic
      const parts = topic.split('/');
      
      // Skip if not a valid sensor data topic (must have at least 4 parts)
      if (parts.length < 4) {
        if (this.config.verbose) {
          //Dont report this - its expected
          //console.log('Skipping non-sensor topic (too few parts):', topic);
        }
        return;
      }
      
      // Extract parts: org, project, node, and everything else as sensor topic path
      const orgId = parts[0];
      const projectId = parts[1];
      const nodeId = parts[2];
      // Join remaining parts as sensor topic path (handles both "temperature" and "sht/temperature")
      // Changed: Renamed from 'topicPath' to 'sensorTopicPath' to avoid confusion with nodeKey
      const sensorTopicPath = parts.slice(3).join('/');

      // Skip if any part is undefined or empty
      if (!orgId || !projectId || !nodeId || !sensorTopicPath) {
        console.log('Skipping invalid topic structure:', topic);
        return;
      }
      
      // Check if node filtering is enabled
      // Changed: Now supports both full paths (dev/developers/esp32-6c5e0e) and node IDs (esp32-6c5e0e)
      // Uses topic.startsWith() for efficient prefix matching as suggested
      if (this.config.allowedNodes && this.config.allowedNodes.length > 0) {
        const nodeTopicPrefix = `${orgId}/${projectId}/${nodeId}`;
        // Check if any allowedPath matches:
        // - Full path match: "dev/developers/esp32" matches "dev/developers/esp32-6c5e0e"
        // - Node ID match: "esp32-6c5e0e" matches nodeId directly
        const isAllowed = this.config.allowedNodes.some(allowedPath => 
          nodeTopicPrefix.startsWith(allowedPath) || allowedPath === nodeId
        );
        if (!isAllowed) {
          if (this.config.verbose) {
            //Not reporting this, would just generate lots of lines for non-firebase nodes
            //console.log('Skipping node not in allowedNodes:', nodeId);
          }
          return;
        }
      }
      
      const timestamp = date.valueOf();
      const topicKey = sensorTopicPath.replace(/\//g, '_');
      
      // Initialize node storage if needed
      const nodeKey = `${orgId}/${projectId}/${nodeId}`;
      if (!this.nodeLatestValues[nodeKey]) {
        this.nodeLatestValues[nodeKey] = {};
      }

      // Validate value type before storing
      // Firebase Realtime Database natively supports: numbers, booleans, strings, objects, arrays
      // Skip only invalid values that cause Firebase errors: undefined, NaN, Infinity
      // Note: null is technically valid in Firebase but we skip it as it represents "no data"
      if (value === undefined || value === null || 
          (typeof value === 'number' && (isNaN(value) || !isFinite(value)))) {
        if (this.config.verbose) {
          console.log('Skipping invalid value for Firebase:', topic, value);
        }
        return;
      }

      // Supports all Firebase-compatible types:
      //   - Numbers: int (0, 1, 100) and float (25.3, 43.2)
      //   - Booleans: true/false (for relay states, on/off indicators)
      //   - Strings: text data
      //   - Objects/Arrays: complex data structures
      this.nodeLatestValues[nodeKey][topicKey] = value;
      
      // Build simplified path - just nodes/{nodeId}
      const nodePath = `nodes/${nodeId}`;
      
      // Update "latest" - only write the specific sensor value that changed
      // Changed: Use update() instead of set() for efficiency
      // Previously wrote ALL sensor values on every MQTT message (very inefficient)
      // Now only writes the single value that changed + timestamp
      // e.g., when sht_temperature arrives, only writes to nodes/esp12345/latest/sht_temperature
      // Note: ISO date string can be derived client-side: new Date(timestamp).toISOString()
      const updateData = {
        [topicKey]: value,
        timestamp: timestamp
      };

      this.db.ref(`${nodePath}/latest`).update(updateData, (err) => {
        if (err) {
          console.error('Firebase latest update error:', err);
        } else {
          if (this.config.verbose) {
            console.log('Firebase latest updated:', nodeId, topicKey);
          }
        }
      });

      // Note: History is saved periodically by timer, not on every sensor update
      
    } catch (error) {
      console.error('Firebase write failed:', error);
    }
  }
  handleMessage(date, topic, value) {
    this.writeData(date, topic, value);
  }
}
class Gsheet extends Forwarder {
  constructor(config, org) {
    super(config, org);
  }
  start() {
    super.start();
  }

  // This function runs periodically and writes to the Google spreadsheet
  tick() {
    let row = this.makeRow(); // array of values, no date since date is typically system dependent
    // The first column is always the date
    let date = new Date();
    // Google sheets wants ISO format, but will fail if it has the Z on the end. So sending e.g. 2025-07-25T10:20:01
    row.unshift(date.toISOString().substring(0,19)); // First column is date
    // Sending the target sheet, but for now it is ignored
    let dataToSend = {
      sheet: this.config.sheet,
      row: row,
    }
    // Now send with HTTP,
    fetch(this.config.url, {
      method: 'POST', // Specify the HTTP method as POST
      headers: {
        'Content-Type': 'application/json', // Indicate that the request body is JSON
      },
      body: JSON.stringify(dataToSend), // Convert the JavaScript object to a JSON string
    })
    // And check the result and report to console
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to append to ${this.config.url} status: ${response.status}`);
      }
    })
    /* -debugging
    .then(data => {
      console.log('Success:', this.config.url, data); // Log the successful response data
    }) */
    .catch(error => {
      console.error('Error:', error); // Log any errors during the fetch operation
    });
 }
}
// ================== Main Logger Class ========================
class MqttLogger {
  constructor() {
    this.clients = {};
  }


  // reportNodes is used by the frugal-iot-server to report the last seen date of each node
  // noinspection JSUnusedGlobalSymbols
  /*
  OBSreportNodes() {  // { org: { project: { node: date }}}
    let report = {};
    Object.entries(this.clients).forEach(([k,v]) => { // Loop over organizations
      report[k] = v.projects;
    });
    return report;
  }
  */
  reportNodes() {
    //TODO-58 filter by user having access
    let res = {};
    Object.entries(this.clients).forEach(([orgId,org]) => { // Loop over organizations
      res[orgId] = org.reportNodes();
    });
    return res;
  }
  // This is a generic config reader that reads a config.yaml and a config.d directory
  // It could be put in its own module

  readConfigFromYamlFile(inputFilePath, cb) {
    console.log("readYamlConfigFile", inputFilePath);
    async.waterfall([
        (cb1) => readFile(inputFilePath, 'utf8', cb1),
        (yamldata, cb1) => cb1(null, yaml.load(yamldata, {onWarning: (warn) => console.log('Yaml warning:', warn)})),
      ],
      cb
    );
  }
  readConfigFromDir(inputDirPath, cb) {
    console.log("readYamlConfigDir", inputDirPath);
    let config_d = {}; // Portion of total config
    async.waterfall([
      (cb1m) => readdir(inputDirPath, {withFileTypes: true}, cb1m),
      (files, cb1n) => {
        async.each(files, (file, cb2) => {
          if (file.isDirectory()) {
            this.readConfigFromDir(`${inputDirPath}/${file.name}`, (err, data) => { // Recursively read subdir
              if (err) {
                cb2(err);
              } else {
                let sub = file.name;
                config_d[sub] = data;
                cb2(null);
              }
            });
          } else {
            this.readConfigFromYamlFile(`${inputDirPath}/${file.name}`, (err, data) => {
              if (err) {
                cb2(err);
              } else {
                let sub = file.name.replace(/\.yaml$/, '');
                config_d[sub] = data;
                cb2(null);
              }
            });
          }
        }, cb1n);
      },
    ], (err) => cb(err, config_d));
  }
  // Call cb(null, config object tree) or cb(err)
  readYamlConfig(inputDirPath, cb) {
    async.waterfall([
      (cb1a) => this.readConfigFromYamlFile(`${inputDirPath}/config.yaml`, cb1a),
      (config, cb1b) => {
        if (!config) config = {}; // If file is empty
        this.readConfigFromDir(`${inputDirPath}/config.d`, (err, config_d) => {
          if (err) {
            console.log(err); // Report it, but don't worry if dir does not exist
            cb1b(null, config); // Just return the main config
            // cb1b(err); // dont want an error from a non-existent `config.d`
          } else {
            Object.entries(config_d).forEach(([k, v]) => {
              config[k] = v;
            });
            cb1b(null, config);
          }
        });
      },
    ], (err, config) => {
      if (err) {
        cb(err);
      } else {
        this.config = config; // Note this keeps a (shared) pointer to the config for the Logger object, even if this was called from server
        cb(null, config);
      }
    });
  }

  // End of generic yaml config reader

  // Start the logger, iterating over config.organizations and starting an MQTT client for each
  start() {
    // noinspection JSUnresolvedReference
    for (let [oid, oconfig] of Object.entries(this.config.organizations)) {
      let c = new MqttOrganization(oid, oconfig, this.config.mqtt, this.config.schema); // Will subscribe when connects
      this.clients[oid] = c;
      c.startClient();
    }
  }
}

export { MqttLogger, MqttOrganization };