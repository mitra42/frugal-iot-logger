// noinspection JSAssignmentUsedAsCondition,JSUnresolvedReference

/*
 * Basic Logger for the Frugal IoT project
 *
 * Intended to be run as part of an HTTP server but could be run standalone
 *
 */

import async from 'async'; // https://caolan.github.io/async/v3/docs.html
import yaml from 'js-yaml'; // https://www.npmjs.com/package/js-yaml
import { appendFile, appendFileSync, mkdir, mkdirSync, readFile, readdir } from "fs"; // https://nodejs.org/api/fs.html
import mqtt from 'mqtt'; // https://www.npmjs.com/package/mqtt
import admin from 'firebase-admin'; // Firebase Admin SDK
//import tospliced from 'array.prototype.tospliced'; // tospliced only in Node > 20 (and webstorm currently 18)

// =======
// Ignore any of these legacy topic - should go away when MQTT memory next cleared as not in any current device
// Still there as of 2026-02-24
// Note - not being in this list should not be a problem - it will be ignored since type not found
const legacytopics = ["wifistrength", "state", "co2", "auto", "reboot", "temp_setpoint", "temp_hysteresis", "temp_out", "hysterisis"];
const legacymodules = ["blinken_out","messages", "now"];

// =======
// Report every message received on the console. That is one line per message, which on a server
// whose console goes to the systemd journal means one write to disk per message - too much for a
// machine running from an SD card, where writes wear the card out. Set "verbose: false" in
// config.d/logger.yaml to turn it off; left on when the setting is absent so that an existing
// server keeps behaving as it did. Set from the config in MqttLogger.start().
let verbose = true;

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

// significantvalue can be an absolute delta e.g. 0.5, or a percentage of the last value e.g. "2%"
// Returns true if value has moved far enough from lv to be worth recording.
function significantlyDifferent(value, lv, significantvalue) {
  if (typeof(significantvalue) === 'string' && significantvalue.trim().endsWith('%')) {
    let pct = Number(significantvalue.trim().slice(0, -1));
    if (isNaN(pct)) { return XXX(["Unparsable significantvalue percentage", significantvalue]); }
    if (lv === 0) { return value !== 0; } // Can't take a percentage of zero, any change is significant
    return (Math.abs(value - lv) / Math.abs(lv) * 100) >= pct;
  }
  return Math.abs(value - lv) >= significantvalue;
}

function isDuplicate(date, topic, value, rules, lastdate, lastvalue) {
  if (rules) {
    let ld = lastdate || 0;
    let lv = lastvalue || 0;
    if ((date === ld) && (value === lv)) return true; // Eliminate any exact duplicates
    if (rules.significantvalue && significantlyDifferent(value, lv, rules.significantvalue)) { return false; }
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
    case "exponential":
      return Number(message);
    case "float":
      return Number(message);
    case "int":
      return Number(message);
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
// ========= Collecting readings in memory, and writing them out a batch at a time =========
// Writing each reading to its file as it arrives is what wears out an SD card. Each one is an
// open-write-close of its own, and since there is a file per topic per day the writes are spread
// over a hundred or more files, so nothing coalesces them. Instead rows are collected here and
// written a batch at a time - one write per file per flush, however many readings arrived.
//
// The cost is that readings not yet written exist only in memory, so pulling the power loses up to
// "flushseconds" of them. Stopping the server cleanly writes them out first (see the signal
// handlers in MqttLogger.start), and so does reading the data back, because the server flushes
// before serving anything out of data/.

const pending = new Map();   // "path/filename" -> lines waiting to be written to that file
let pendingRows = 0;         // counted across every file, so one limit covers them all
const knownDirs = new Set(); // directories already created, so mkdir is not called per reading
let flushSeconds = 0;        // 0 = write each reading as it arrives, which is what older versions did
let flushTimer = null;
let flushing = false;        // a batch is being written right now
let flushWaiting = [];       // callbacks that arrived during that write and need one of their own

// Write out early if this many rows are waiting, rather than holding them for the full interval.
// A row is a few dozen bytes, so this is little memory - the point is that a server with many
// nodes never sits on an unbounded amount of unwritten data.
const FLUSH_MAX_ROWS = 2000;

function appendPending(path, filename, message) {
  let key = `${path}/${filename}`;
  let lines = pending.get(key);
  if (lines) { lines.push(message); } else { pending.set(key, [message]); }
  pendingRows++;
  if (!flushSeconds || (pendingRows >= FLUSH_MAX_ROWS)) {
    flushPending();
  }
}

// Write everything waiting, then call back. Safe to call at any time, including when there is
// nothing to write, which is what makes it cheap enough to call before serving a request.
function flushPending(cb) {
  cb = cb || (() => {});
  if (flushing) {
    // Rows may arrive after the batch now being written was taken, so a caller who asked while it
    // was running gets a flush of its own once this one is finished, rather than joining it.
    flushWaiting.push(cb);
    return;
  }
  if (!pending.size) { cb(); return; }
  flushing = true;
  let batch = [...pending.entries()];
  pending.clear();
  pendingRows = 0;
  // One file at a time: a Pi Zero W has one core and little memory, and there is no hurry
  async.eachSeries(batch, ([key, lines], cb1) => {
    let write = () => appendFile(key, lines.join(''), (err) => {
      // Nothing is retried and nothing is put back: if the card is full or read-only, holding the
      // rows would grow memory until the process died, which is worse than losing them noisily.
      if (err) console.error("Could not write", key, "-", err.message, `(${lines.length} readings lost)`);
      cb1(null);
    });
    let dir = key.substring(0, key.lastIndexOf('/'));
    if (knownDirs.has(dir)) {
      write();
    } else {
      mkdir(dir, {recursive: true}, (err) => {
        if (err) {
          console.error("Could not create", dir, "-", err.message, `(${lines.length} readings lost)`);
          cb1(null);
        } else {
          knownDirs.add(dir);
          write();
        }
      });
    }
  }, (err) => {
    flushing = false;
    let waiting = flushWaiting;
    flushWaiting = [];
    cb(err);
    if (waiting.length) {
      flushPending((err2) => waiting.forEach((w) => w(err2)));
    }
  });
}

// Last resort, for the process ending some way other than a signal - an uncaught exception, or
// simply nothing left to do. Node allows no asynchronous work once "exit" has been reached, so
// this is the one place the writes have to be synchronous.
function flushPendingSync() {
  if (!pending.size) return;
  for (let [key, lines] of pending.entries()) {
    try {
      let dir = key.substring(0, key.lastIndexOf('/'));
      if (!knownDirs.has(dir)) { mkdirSync(dir, {recursive: true}); knownDirs.add(dir); }
      appendFileSync(key, lines.join(''));
    } catch (err) {
      console.error("Could not write", key, "while stopping -", err.message);
    }
  }
  pending.clear();
  pendingRows = 0;
}

// Called from MqttLogger.start once the config has been read
function startFlushing(seconds) {
  flushSeconds = seconds || 0;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (flushSeconds > 0) {
    flushTimer = setInterval(() => flushPending(), flushSeconds * 1000);
    if (flushTimer.unref) flushTimer.unref(); // Never a reason to keep the process alive just for this
    console.log("Collecting readings in memory, writing them out every", flushSeconds, "seconds");
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
        if (verbose) console.log("Received", topic, " ", msg);
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
      if (o.projects) {
        for (let [pid, p] of Object.entries(o.projects)) {
          this.watchProject(pid, p);
          // Subscribe to everything on this organization - probably quicker than throwing stuff away
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

   schemaField(module, leaf, field) {
     let moduleSchema = this.config_schema.modules[module];
     let moduleTopicSchema = moduleSchema && moduleSchema.topics.find(t => (t.leaf === leaf));
     let topicLeaf = (moduleTopicSchema && moduleTopicSchema["leaf_from"]) || leaf; // Always exists - at worst, if no module, its leaf directly to topics
     let topicSchema = this.config_schema.topics[topicLeaf];
     // Check for override in the module schema, otherwise from topic schema.
     // Whether the field is there at all, not whether its value is truthy: "log: false",
     // "wireable: false" and "min: 0" are all settings somebody wrote deliberately, and an "||"
     // here would step over them and use the topic's value instead.
     if (moduleTopicSchema && (moduleTopicSchema[field] !== undefined)) return moduleTopicSchema[field];
     if (topicSchema && (topicSchema[field] !== undefined)) return topicSchema[field];
     return undefined;
   }

   /**
    * Get schema for a module by expanding all its topics
    * Uses leaf_from to fetch from topics schema, overriding with local values
    * @param {string} module - Module name
    * @returns {Object} Schema for the module with fields array
    */
   schemaModule(module) {
     const moduleConfig = this.config_schema.modules[module];
     const moduleSchema = {
       name: (moduleConfig && moduleConfig.name) || module,
       fields: []
     };

     if (!moduleConfig || !moduleConfig.topics) {
       return moduleSchema; // Empty module if not defined
     }

     // Iterate through topics defined for this module
     moduleConfig.topics.forEach(topicDef => {
       const leaf = topicDef.leaf;
       const topicLeaf = topicDef.leaf_from || leaf; // Use leaf_from if defined, otherwise use leaf
       const topicSchema = this.config_schema.topics[topicLeaf];

       // Build field schema starting with basic required fields
       const fieldSchema = {
         field: leaf,
         name: topicDef.name || leaf,
         type: topicDef.type || (topicSchema && topicSchema.type) || 'float',
         rw: topicDef.rw || (topicSchema && topicSchema.rw) || 'r'
       };

       // Add optional properties if defined
       if (topicDef.units || (topicSchema && topicSchema.units)) {
         fieldSchema.units = topicDef.units || topicSchema.units;
       }
       if (topicDef.min !== undefined) {
         fieldSchema.min = topicDef.min;
       } else if (topicSchema && topicSchema.min !== undefined) {
         fieldSchema.min = topicSchema.min;
       }
       if (topicDef.max !== undefined) {
         fieldSchema.max = topicDef.max;
       } else if (topicSchema && topicSchema.max !== undefined) {
         fieldSchema.max = topicSchema.max;
       }

       // Preserve any additional Frugal IoT specific properties from topicDef
       // This includes custom fields like color, slot, etc.
       Object.entries(topicDef).forEach(([key, value]) => {
         if (!['leaf', 'name', 'type', 'rw', 'units', 'min', 'max', 'leaf_from'].includes(key)) {
           fieldSchema[key] = value;
         }
       });

       // Also preserve additional properties from topicSchema if not already in topicDef
       if (topicSchema) {
         Object.entries(topicSchema).forEach(([key, value]) => {
           if (!fieldSchema.hasOwnProperty(key) && !['type', 'rw', 'units', 'min', 'max'].includes(key)) {
             fieldSchema[key] = value;
           }
         });
       }

       moduleSchema.fields.push(fieldSchema);
     });

     return moduleSchema;
   }

   /**
    * Get list of modules for a specific node
    * Filters currentValue to find all modules that have been observed for this node
    * @param {string} nodeName - Node ID
    * @returns {Array<string>} Array of module names observed for this node
    */
   modulesNode(nodeName) {
     const modules = new Set();

     // Iterate through all currentValue entries
     Object.keys(this.currentValue).forEach(topicPath => {
       // Topic path format: project/node/module/leaf or project/node/set/module/leaf
       const parts = topicPath.split('/');

       // Find the node in the path and get the module
       const nodeIndex = parts.indexOf(nodeName);
       if (nodeIndex !== -1 && nodeIndex < parts.length - 2) {
         // Check if next part is "set" (legacy) or a module
         let moduleIndex = nodeIndex + 1;
         if (parts[moduleIndex] === 'set') {
           moduleIndex++;
         }

         if (moduleIndex < parts.length) {
           const module = parts[moduleIndex];
           // Only add if it's a valid module (not a numeric index or parameter)
           if (module && !module.match(/^\d+$/)) {
             modules.add(module);
           }
         }
       }
     });

     return Array.from(modules).sort();
   }

   /**
    * Get complete schema for a node
    * Uses modulesNode to get list of modules, then schemaModule to expand each
    * @param {string} nodeName - Node ID
    * @returns {Object} Complete node schema with all modules and fields
    */
   schemaNode(nodeName) {
     const schema = {
       modules: {}
     };

     // Get all modules for this node
     const modules = this.modulesNode(nodeName);

     // Build schema for each module
     modules.forEach(module => {
       schema.modules[module] = this.schemaModule(module);
     });

     return schema;
   }
  // Search various places in priority order to get value for a field -
  // There used to be a way to override at organization or project level, but no longer -could add back in here if required but would need new way to configure it.
  findMostGranular(topicPathArray, field, def) { // topicPathArray = [ project, node, module, leaf ]
    // The default applies when the schema does not mention the field, not when its value happens to
    // be falsy - otherwise "log: false" in the schema would be overruled by the default
    let found = this.schemaField(topicPathArray[2], topicPathArray[3], field);
    return (found === undefined) ? def : found;
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
    appendPending(path, filename, message);
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
  // Return a structure { projectid: { nodeid: { moduleid/leaf: value } but just for those fields in reportLeafs and lastseen
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
        let p = (res[projectid] || (res[projectid] = {}));
        let n = (p[nodeid] || (p[nodeid] = {}));
        n['lastseen'] = lastseen;
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

   /**
    * Map frugal-iot types to W3C WoT types
    * According to WoT Thing Description spec 5.3.2.1
    * @param {string} frugalType - Type from frugal-iot schema
    * @returns {string} WoT type
    */
   mapTypeToWoT(frugalType) {
     const typeMap = {
       'bool': 'boolean',
       'int': 'integer',
       'float': 'number',
       'text': 'string',
       'topic': 'string',
       'color': 'string',
       'yaml': 'object'
     };
     return typeMap[frugalType] || 'string';
   }

    /**
     * Build a schema field object according to WoT specification 5.3.1.1
     * Preserves Frugal IoT specific metadata in a frugal-iot namespace
     * @param {Object} fieldSchema - Field schema from our module
     * @param {string} moduleTitle - Display name of the module (e.g. "LED")
     * @param {boolean} isWritable - Whether this is a writable field
     * @returns {Object} WoT schema object with WoT standard fields and frugal-iot extensions
     */
    buildWoTSchemaObject(fieldSchema, moduleTitle, isWritable) {
      const fieldName = fieldSchema.name || fieldSchema.field;
      const schemaObj = {
        type: this.mapTypeToWoT(fieldSchema.type),
        title: fieldName,
        description: `${moduleTitle}: ${fieldName}`
      };

      // Add units if present
      if (fieldSchema.units) {
        schemaObj.unit = fieldSchema.units;
      }

      // Add numeric constraints
      if (fieldSchema.min !== undefined) {
        schemaObj.minimum = fieldSchema.min;
      }
      if (fieldSchema.max !== undefined) {
        schemaObj.maximum = fieldSchema.max;
      }

      // Mark as readOnly or writeOnly based on field type
      if (fieldSchema.rw === 'r' || (!fieldSchema.rw && !isWritable)) {
        schemaObj.readOnly = true;
      } else if (fieldSchema.rw === 'w' || isWritable) {
        schemaObj.writeOnly = true;
      }
      // If 'rw', it's readable and writable - no flags set

      // Preserve Frugal IoT specific metadata under frugal-iot namespace
      // This includes fields like color, slot, and any other custom properties
      const frugalFields = {};
      const standardWoTFields = ['type', 'title', 'description', 'unit', 'minimum', 'maximum', 'readOnly', 'writeOnly'];

      Object.entries(fieldSchema).forEach(([key, value]) => {
        // Skip internal fields and mapped fields
        if (!['field', 'name', 'units', 'min', 'max', 'rw'].includes(key) && !standardWoTFields.includes(key)) {
          frugalFields[key] = value;
        }
      });

      // Add frugal-iot namespace with original metadata if there are custom fields
      if (Object.keys(frugalFields).length > 0) {
        schemaObj['frugal-iot:metadata'] = frugalFields;
      }

      return schemaObj;
    }

   /**
    * Get device schema from logger in W3C Web of Things Thing Descriptor format
    * According to https://www.w3.org/TR/wot-thing-description11/
    * @param {string} org - Organization ID
    * @param {string} project - Project ID
    * @param {string} deviceId - Device ID (node name, e.g., "esp32-123456")
    * @param {string} baseURI - Base URI for the server (e.g., "https://frugaliot.naturalinnovation.org")
    * @returns {Object|null} Device schema in W3C WoT Thing Descriptor format, or null if device not found
    */
   getDeviceSchema(org, project, deviceId, baseURI = 'https://frugaliot.naturalinnovation.org') {
     try {
       // Get the organization client
       const orgClient = this.clients[org];
       if (!orgClient) {
         console.warn(`Organization ${org} not found`);
         return null;
       }

       // Get MQTT broker address from the organization client's config
       const mqttBroker = orgClient.config_mqtt && orgClient.config_mqtt.broker ? orgClient.config_mqtt.broker : null;

       // Get the node schema from the organization
       const nodeSchema = orgClient.schemaNode(deviceId);

       // Check if node has any modules
       if (!nodeSchema.modules || Object.keys(nodeSchema.modules).length === 0) {
         console.warn(`No schema found for node ${deviceId} in ${org}/${project}`);
         return null;
       }

       const deviceId_full = `${org}/${project}/${deviceId}`;
       const properties = {};
       const actions = {};

       // Iterate through all modules and their fields to build properties and actions
       Object.entries(nodeSchema.modules).forEach(([moduleName, moduleSchema]) => {
         if (moduleSchema.fields) {
           moduleSchema.fields.forEach(field => {
             const fieldKey = `${moduleName}/${field.field}`;
             const schemaObj = this.buildWoTSchemaObject(field, moduleSchema.name, false);
             const canRead = field.rw === 'r' || (field.rw && field.rw.includes('r'));
             const canWrite = field.rw === 'w' || (field.rw && field.rw.includes('w'));

             if (canRead) {
               // Readable - a property. If it's ALSO writable, this one property affordance covers
               // both: per the WoT spec, a form with op:["readproperty","writeproperty"] and no
               // htv:methodName is split by a TD Processor into GET-to-read / PUT-to-write against the
               // same href (the HTTP Binding's default op->method mapping) - so a writable field does
               // NOT need a separate action entry, unlike before.
               const op = canWrite ? ['readproperty', 'writeproperty'] : ['readproperty'];
               properties[fieldKey] = {
                 ...schemaObj,
                 forms: [
                   {
                     // Root-relative (resolves against whatever origin fetched this schema, or against
                     // the top-level "base" field above, per RFC3986) - matches the real mounted route.
                     // Includes /api explicitly rather than relying on "base" to supply it, since
                     // root-relative refs resolve against base's authority only, ignoring base's path.
                     href: `/api/devices/property?deviceId=${encodeURIComponent(deviceId_full)}&property=${encodeURIComponent(fieldKey)}`,
                     contentType: 'application/json',
                     op
                   }
                 ]
               };

               // Add MQTT binding(s) if broker is provided
               if (mqttBroker) {
                 properties[fieldKey].forms.push({
                   href: `${mqttBroker}/${deviceId_full}/${moduleName}/${field.field}`,
                   contentType: 'text/plain',
                   op: ['readproperty'],
                   subprotocol: 'mqtt'
                 });
                 if (canWrite) {
                   properties[fieldKey].forms.push({
                     href: `${mqttBroker}/${deviceId_full}/set/${moduleName}/${field.field}`,
                     contentType: 'text/plain',
                     op: ['writeproperty'],
                     subprotocol: 'mqtt'
                   });
                 }
               }
             } else if (canWrite) {
               // Write-only, no readback - a genuine action (e.g. a momentary trigger), unlike a
               // read-write field which is modelled as a property above.
               const actionObj = {
                 title: schemaObj.title,
                 description: schemaObj.description,
                 input: {
                   ...schemaObj
                 },
                 forms: [
                   {
                     // Root-relative - see the property href comment above for why /api is explicit here.
                     // API.md Section 6.6.2's GET companion (6.6.2.1) is the form referenced here.
                     href: `/api/devices/action?deviceId=${encodeURIComponent(deviceId_full)}&action=${encodeURIComponent(fieldKey)}`,
                     contentType: 'application/json',
                     op: ['invokeaction']
                   }
                 ]
               };

               // Add MQTT binding if broker is provided
               if (mqttBroker) {
                 actionObj.forms.push({
                   href: `${mqttBroker}/${deviceId_full}/set/${moduleName}/${field.field}`,
                   contentType: 'text/plain',
                   op: ['invokeaction'],
                   subprotocol: 'mqtt'
                 });
               }

               actions[fieldKey] = actionObj;
             }
           });
         }
       });

       // Build the Thing Descriptor according to W3C spec
       const thingDescriptor = {
         '@context': [
           'https://www.w3.org/2022/wot/td/v1.1',
           {
             'sosa': 'http://www.w3.org/ns/sosa/',
             'ssn': 'http://www.w3.org/ns/ssn/',
             'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
             'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
             'frugal-iot': 'https://github.com/mitra42/frugal-iot/ns/'
           }
         ],
         'id': deviceId_full,
         'title': `Frugal IoT Device - ${deviceId}`,
         'description': `IoT device ${deviceId} in project ${project}/${org}`,
         'base': baseURI,
         'securityDefinitions': {
           'basic_sc': {
             'scheme': 'basic',
             "in": "header"
           }
         },
         'security': ['basic_sc'],
         "forms": [
           {
             // Root-relative, fixed typo (was "deiceId"), matches GET /devices/property with the
             // "property" parameter omitted, which returns every readable field's current value.
             "href": `/api/devices/property?deviceId=${encodeURIComponent(deviceId_full)}`,
             "op": "readallproperties",
             "contentType": "application/senml+json"
           },
           {
             "href": mqttBroker,
             "op": ["observeallproperties","unobserveallproperties"],
             "mqv:filter": `${deviceId_full}/#`,
             "contentType": "text/plain"
           }
         ],
         'properties': properties,
         'actions': actions
       };

       // Add MQTT protocol binding information if broker is provided
       if (mqttBroker) {
         thingDescriptor['mqtt:broker'] = mqttBroker;
         thingDescriptor['mqtt:clientId'] = `frugal-iot-${org}`;
       }

       return thingDescriptor;
     } catch (err) {
       console.error(`Error getting schema for ${org}/${project}/${deviceId}:`, err);
       return null;
     }
   }

  /**
   * Get the current (last known) value of a single readable field for a device.
   * Goes through MqttOrganization.findLastValue() rather than reading currentValue directly, so this
   * stays correct if currentValue's internal representation changes (e.g. to a hierarchical structure).
   * @param {string} org - Organization ID
   * @param {string} project - Project ID
   * @param {string} deviceId - Device ID
   * @param {string} field - Field in "module/field" format
   * @returns {*} The current value, or undefined if never seen or the organization is unknown
   */
  getPropertyValue(org, project, deviceId, field) {
    const orgClient = this.clients[org];
    if (!orgClient) { return undefined; }
    return orgClient.findLastValue(`${org}/${project}/${deviceId}/${field}`);
  }

  /**
   * Get current values for every field in a device's schema that has been seen at least once.
   * @param {string} org - Organization ID
   * @param {string} project - Project ID
   * @param {string} deviceId - Device ID
   * @returns {Object} Map of "module/field" -> current value
   */
  getDeviceCurrentValues(org, project, deviceId) {
    const orgClient = this.clients[org];
    if (!orgClient) { return {}; }
    const nodeSchema = orgClient.schemaNode(deviceId);
    const result = {};
    Object.entries(nodeSchema.modules || {}).forEach(([moduleName, moduleSchema]) => {
      (moduleSchema.fields || []).forEach(field => {
        const fieldKey = `${moduleName}/${field.field}`;
        const value = orgClient.findLastValue(`${org}/${project}/${deviceId}/${fieldKey}`);
        if (value !== undefined) {
          result[fieldKey] = value;
        }
      });
    });
    return result;
  }

  /**
   * Send action to device via MQTT
   * Publishes action to device control topic
   * @param {string} org - Organization ID
   * @param {string} project - Project ID
   * @param {string} deviceId - Device ID
   * @param {string} action - action in "module/field" format
   * @param {*} value - action value (number, boolean, string, etc.)
   * @returns {Promise<{status: string, message: string}>} Result of action send
   */
  async sendAction(org, project, deviceId, action, value) {
    return new Promise((resolve) => {
      try {
        // Validate inputs
        if (!action || !action.includes('/')) {
          resolve({
            status: 'error',
            message: 'Action must be in module/field format'
          });
          return;
        }

        const [module, field] = action.split('/');

        // Get organization client
        const orgClient = this.clients[org];
        if (!orgClient || !orgClient.mqtt_client) {
          resolve({
            status: 'error',
            message: 'Organization not connected to MQTT'
          });
          return;
        }

        const mqttClient = orgClient.mqtt_client;

        // Check if MQTT client is connected
        if (!mqttClient.connected) {
          resolve({
            status: 'error',
            message: 'MQTT broker not connected'
          });
          return;
        }

        // Build MQTT topic for control
        const topic = `${org}/${project}/${deviceId}/set/${module}/${field}`;
        // Devices expect "1"/"0" for booleans, not JS's "true"/"false"
        const message = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);

        // Publish action
        mqttClient.publish(topic, message, { retain: false }, (err) => {
          if (err) {
            resolve({
              status: 'error',
              message: `Failed to publish: ${err.message}`
            });
          } else {
            resolve({
              status: 'sent',
              message: `Action sent to device: ${action} = ${value}`
            });
          }
        });
      } catch (err) {
        resolve({
          status: 'error',
          message: `Exception: ${err.message}`
        });
      }
    });
  }

  // Write out any readings still held in memory. The server calls this before serving anything from
  // data/, so a graph never misses readings just because they have not been written out yet.
  flush(cb) {
    flushPending(cb);
  }

  // Being stopped is normal - "systemctl restart frugaliot" does it, and the unit restarts the
  // server on failure too. Node's default action on these signals is to exit immediately, which
  // would throw away every reading collected since the last write, so catch them and write first.
  catchSignals() {
    if (this.signalsCaught) return; // start() could be called more than once
    this.signalsCaught = true;
    for (let sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        console.log(`Received ${sig} - writing out readings held in memory before stopping`);
        flushPending(() => process.exit(0));
      });
    }
    // Covers every other way of stopping - an uncaught exception, or the process simply running
    // out of things to do - where there is no opportunity to write anything asynchronously
    process.on('exit', () => flushPendingSync());
  }

  // Start the logger, iterating over config.organizations and starting an MQTT client for each
  start() {
    let clog = this.config.logger || {};
    // Absent means true, so a server that has never been told either way keeps reporting messages
    if (clog.verbose === false) {
      verbose = false;
      console.log("Logger not reporting individual messages (verbose: false in config.d/logger.yaml)");
    }
    // Absent means 0, writing each reading as it arrives, so an existing server is not silently
    // given a window in which a power cut would lose readings.
    startFlushing(clog.flushseconds);
    this.catchSignals();
    // noinspection JSUnresolvedReference
    for (let [oid, oconfig] of Object.entries(this.config.organizations)) {
      let c = new MqttOrganization(oid, oconfig, this.config.mqtt, this.config.schema); // Will subscribe when connects
      this.clients[oid] = c;
      c.startClient();
    }
  }
}

export { MqttLogger, MqttOrganization };