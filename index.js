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

// =========== Some generic helper functions, not specific to this client ========
// Clean any leading "/" or "../" from a string so it can be safely appended to a path
function sanitizeUrl(t) {
  if(t && t[0] === '/') { return sanitizeUrl(t.substring(1)); }
  return (t.replaceAll("../",""));
}

function findMostGranular(o, topicpath, f) {
  let i = topicpath.indexOf('/');
  let n = (i < 0) ? topicpath : topicpath.substring(0, i);
  let topicrest = (i < 0) ? null : topicpath.substring(i + 1);
  if (topicrest) {
    let oo = o.projects || o.nodes || o.sub // Next step depends on if org, project, node or topic
    return (
      (oo[n] && findMostGranular(oo[n], topicrest, f))
      || (oo['+'] && findMostGranular(oo['+'], topicrest, f))
    );
  } else { // No more path, so look for n.field
    let oo = o.topics // Next step depends on if org, project, node or topic
    return (
      ((typeof (f) === 'string') && oo[n][f])
      || ((typeof (f) === 'function') && f(oo[n]))
    );
  }
}

// Class with one object per subscription including de-duplication rules.
// Subscriptions are held under the Organization level, and can include wild-card subscriptions.
class Subscription {
  constructor(topic, qos, duplicates, type, cb) {
    this.topic = topic;
    this.qos = qos;
    this.type = type;
    this.cb = cb;
    this.currentvalue = {};
    this.lastdate = {};
    this.lastvalue = {};
    this.duplicates = duplicates; // Rules to follow
  }
  matches(topic) {
    if (this.topic.includes('+')) {
      function m(x,y) { return (x === y) || (y === '+')}
      let [ o,p,n,t] = topic.split('/');
      let [ os,ps,ns,ts] = this.topic.split('/');
      return m(o,os) && m(p,ps) && m(n,ns) && m(t,ts);
    } else {
      return this.topic === topic;
    }
  }
  isDuplicate(date, topic, value) {
    let rules = this.duplicates;
    if (rules) {
      let ld = this.lastdate[topic] || 0;
      let lv = this.lastvalue[topic] || 0;
      if ((date === ld) && (value === lv)) return true; // Eliminate any exact duplicates
      if (rules.significantvalue && (Math.abs(value - lv) > rules.significantvalue)) { return false; }
      if (rules.significantdate && ((date-ld) > rules.significantdate)) { return false; }
      if (rules.significantdate || rules.significantvalue) { return true; } // Conditions but didn't meet any of them
    }
    return false; // No conditions or no rules (e.g. for discovery at org/project=node
  }

  dispatch(topic, message) {
    // Dispatch, but don't dispatch duplicates
    let value = this.valueFromText(message);
    let date = new Date();
    this.currentvalue[topic] = value; // Save current value for e.g. Gsheets
    if (!this.isDuplicate(date, topic, value)) {
      this.lastdate[topic] = date;
      this.lastvalue[topic] = value;
      this.cb(date, topic, message);
    }
  }

  // NOTE same function in frugal-iot-logger and frugal-iot-client if change here, change there
  valueFromText(message) {
    switch(this.type) {
      case "bool":
        return Number(message); // Message "0" or "1" and want to store number anyway
      case "float":
        return Number(message)
      case "int":
        return Number(message)
      case "topic":
        return message;
      case "text":
        return message;
      case "yaml":
        // noinspection JSUnusedGlobalSymbols
        return yaml.load(message, {onWarning: (warn) => console.log('Yaml warning:', warn)});
      default:
        console.error(`Unrecognized message type: ${this.type}`);
    }
  }
}
// ================== MQTT Client embedded in server ========================

// Manages a connection to a broker - each organization needs its own connection
class MqttOrganization {
  constructor(id, config_org, config_mqtt) {
    this.id = id;
    this.config_org = config_org; // Config structure currently: { name, mqtt_password, projects: { id: { topics: { temperature , humidity }
    this.config_mqtt = config_mqtt; // { broker }
    this.mqtt_client = null; // Object from library
    // noinspection JSUnusedGlobalSymbols
    this.status = "constructing"; // Note that the status isn't currently available anywhere
    this.projects = {};
    this.subscriptions = [];
    this.gsheets = [];
    this.firebase = null;
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

  subscribe(topic, qos, duplicates, type, cb) {
    this.mqtt_subscribe(topic, qos);
    this.subscriptions.push(new Subscription(topic, qos, duplicates, type, cb));
  }
  quickdiscover(date, topic, message) {
    // Save a record of a quickdiscover message so we know when last seen
    // topic = "orgid/projectid"  message = "nodeid"
    let pid = topic.split('/')[1];
    let nid = message;
    if (!this.projects[pid]) { this.projects[pid] = {}; }
    //console.log("XXX client11",pid,nid,date)
    this.projects[pid][nid] = date;
  }
  // noinspection JSUnusedLocalSymbols
  watchProject(pid, p) {
    // Things to do regarding the project, other than subscribing based on config
    // Watch for quickdiscover messages and record last time node seen
    this.subscribe(`${this.id}/${pid}`, 0, null, "text", this.quickdiscover.bind(this));
  }
  configSubscribe() {
    // noinspection JSUnresolvedReference
    if (this.subscriptions.length === 0) { // connect is called after onReconnect - do not re-add subscriptions
      let o = this.config_org;
      for (let [pid, p] of Object.entries(o.projects)) {
        this.watchProject(pid, p);
        this.recursivelySubscribe(pid, p);
      }
    }
  }
  recursivelySubscribe(subPathSoFar, o) { // subPathSoFar excludes starting "org"  note
    if (o.topics) {
      for (let topicid of Object.keys(o.topics)) {
        let topicSubPath = subPathSoFar + "/" + topicid;
        let duplicates = findMostGranular(this.config_org, topicSubPath, "duplicates");
        let type = findMostGranular(this.config_org, topicSubPath, "type");
        this.subscribe(`${this.id}/${topicSubPath}`, 0, duplicates, type, this.messageReceived.bind(this));
      }
    }
    for (let z of [o.sub, o.nodes]) {
      if (z) {
        for (let [subid, s] of Object.entries(z)) {
          this.recursivelySubscribe(subPathSoFar + "/" + subid, s);
        }
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
  // Called by s.dispatch, currently all the same
  messageReceived(date, topic, message) {
      this.log(date, topic, message);
      // Send to Firebase if configured
      if (this.firebase) {
        // Find the subscription to get the parsed value (already converted to correct type)
        let s = this.subscriptions.find(s => s.matches(topic));
        let value = s ? s.currentvalue[topic] : message;
        // Pass only value (not message) - message is raw string, value is parsed/typed
        // Filtering by allowedNodes happens inside writeData
        this.firebase.writeData(date, topic, value);
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
  // Starting with a topic return the current value of the topic - for periodic forwarders.
  findLastValue(topic) {
    let s = this.subscriptions.find(s => s.matches(topic));
    return s && s.currentvalue[topic];
  }

  // Initialize Firebase integration if configured in the organization's YAML config
  // Pattern matches gsheetsSubscribe - create instance, store reference, then start
  firebaseSubscribe() {
    if (this.config_org.firebase) {
      let fb = new Firebase(this.config_org.firebase, this);
      this.firebase = fb;
      fb.start();
    }
  }
}  // MqttOrganization

// ================== Firebase Integration ========================
class Firebase {
  constructor(config, org) {
    this.config = config;
    this.org = org;
    this.db = null;
    this.initialized = false;
    // Store latest values for each node to create snapshots
    this.nodeLatestValues = {}; // { nodeKey: { topicKey: value } } - simplified structure
    // Track last written history to avoid duplicates when nodes are asleep
    this.lastWrittenHistory = {}; // { nodeKey: JSON string of last history data }
    this.historyTimer = null;
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
      this.initialized = true;
      console.log('Firebase initialized for org:', this.org.id);
      
      // Start periodic history saving
      const historyInterval = (this.config.historyIntervalSeconds || 60) * 1000;
      this.historyTimer = setInterval(() => {
        this.saveHistoryForAllNodes();
      }, historyInterval);
      
    } catch (error) {
      console.error('Firebase initialization failed:', error);
    }
  }
  
  // Clean up resources when stopping
  stop() {
    if (this.historyTimer) {
      clearInterval(this.historyTimer);
      this.historyTimer = null;
    }
    this.initialized = false;
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
      historyData.timestamp = Date.now();
      historyData.date = new Date().toISOString();
      
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
    }
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
          console.log('Skipping non-sensor topic (too few parts):', topic);
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
            console.log('Skipping node not in allowedNodes:', nodeId);
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

      // Changed: Simplified data structure - store only the value directly
      // Previously stored {value, timestamp, date, raw} but only value was ever used
      // This makes the code simpler and more efficient
      this.nodeLatestValues[nodeKey][topicKey] = value;
      
      // Build simplified path - just nodes/{nodeId}
      const nodePath = `nodes/${nodeId}`;
      
      // Update "latest" - copy all sensor values plus timestamp
      // Changed: Now uses spread operator {...} for simple copy since we store values directly
      const latestData = {...this.nodeLatestValues[nodeKey]};
      latestData.timestamp = timestamp;
      latestData.date = date.toISOString();
      
      this.db.ref(`${nodePath}/latest`).set(latestData)
        .then(() => {
          if (this.config.verbose) {
            console.log('Firebase latest updated:', nodeId);
          }
        })
        .catch((error) => {
          console.error('Firebase latest update error:', error);
        });
      
      // Note: History is saved periodically by timer, not on every sensor update
      
    } catch (error) {
      console.error('Firebase write failed:', error);
    }
  }
}
class Gsheet {
  constructor(config, org) {
    this.config = config;
    this.org = org;
  }
  start() {
    //https://developer.mozilla.org/docs/Web/API/setInterval
    setInterval(this.tick.bind(this), this.config.intervalSeconds * 1000);
    // No authentication or initialization required for Gsheets
  }

  // This function runs periodically and writes to the Google spreadsheet
  tick() {
    // Set up an array with the values of the topics we are monitoring in the same order as in the configuration
    let row = this.config.topics
      .map((topic) => this.org.findLastValue(topic));
    // The first column is always the date
    let date = new Date();
    // Google sheets wants ISO format, but will fail if it has the Z on the end. So sending e.g. 2025-07-25T10:20:01
    row.unshift(date.toISOString().substring(0,19)); // First column is date // TODO-9 check this is correct format for date in gsheet
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
    //TODO-9 comment out on success
    .then(data => {
      //console.log('Success:', this.config.url, data); // Log the successful response data
    })
    .catch(error => {
      console.error('Error:', error); // Log any errors during the fetch operation
    });
 }
}
class MqttLogger {
  constructor() {
    this.clients = {};
  }

  // reportNodes is used by the frugal-iot-server to report the last seen date of each node
  // noinspection JSUnusedGlobalSymbols
  reportNodes() {  // { org: { project: { node: date }}}
    let report = {};
    Object.entries(this.clients).forEach(([k,v]) => { // Loop over organizations
      report[k] = v.projects;
    });
    return report;
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
        this.config = config;
        cb(null, config);
      }
    });
  }

  // Start the logger, iterating over config.organizations and starting an MQTT client for each
  start() {
    // noinspection JSUnresolvedReference
    for (let [oid, oconfig] of Object.entries(this.config.organizations)) {
      let c = new MqttOrganization(oid, oconfig, this.config.mqtt); // Will subscribe when connects
      this.clients[oid] = c;
      c.startClient();
    }
  }
}

export { MqttLogger, MqttOrganization };