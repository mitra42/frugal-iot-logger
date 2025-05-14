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

// =========== Some generic helper functions, not specific to this client ========
// Clean any leading "/" or "../" from a string so it can be safely appended to a path
function sanitizeUrl(t) {
  if(t && t[0] === '/') { return sanitizeUrl(t.substring(1)); }
  return (t.replaceAll("../",""));
}

// Functions on config structures - see more in frugal-iot-client
// Find where in o (config at the organizational level) is the most detailed response e.g. the field on the project will be overridden by one on a topic.
function findMostGranularN(n, topicpath, field) {
  // noinspection JSUnusedLocalSymbols
  // TODO-n130 this is presuming that the topicpath is always org/project/node/topic not ...node/+/topic
  let [unusedOrg, unusedProject, node, topic] = topicpath.split('/');
  let t,f;
  if (t = n.topics[topic]) {
    if (f = t[field]) { return f; }
  }
  if (t = n.topics['+']) {
    if (f = t[field]) { return f; }
  }
  if (f = n[field]) { return f; }
  return null;
}
function findMostGranularP(p, topicpath, field) {
  // noinspection JSUnusedLocalSymbols
  let [unusedOrg, unusedProject, node, topic] = topicpath.split('/');
  let n,f; // t not used
  if (n = p.nodes[node]) {
    if (f = findMostGranularN(n, topicpath, field)) { return f; }
  }
  if (n = p.nodes['+']) {
    if (f = findMostGranularN(n, topicpath, field)) { return f; }
  }
  if (f = p[field]) { return f; }
  return null;
}
function findMostGranular(o, topicpath, field) {
  // noinspection JSUnusedLocalSymbols
  let [unusedOrg, project, node, topic] = topicpath.split('/');
  let p,f; // n,t not used
  if (p = o.projects[project]) {
    if (f = findMostGranularP(p, topicpath, field)) { return f; }
  }
  if (p = o.projects['+']) {
    if (f = findMostGranularP(p, topicpath, field)) { return f; }
  }
  if (f = o[field]) { return f;}
  return null;
}
function findMostGranular2(o, topicpath, f) {
  let i = topicpath.indexOf('/');
  let n = (i < 0) ? topicpath : topicpath.substring(0, i);
  let topicrest = (i < 0) ? null : topicpath.substring(i + 1);
  if (topicrest) {
    let oo = o.projects || o.nodes || o.sub // Next step depends on if org, project, node or topic
    return (
      (oo[n] && findMostGranular2(oo[n], topicrest, f))
      || (oo['+'] && findMostGranular2(oo['+'], topicrest, f))
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
  configSubscribe() { // TODO-130 rewrite so not fixed on number of levels
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
        let duplicates = findMostGranular2(this.config_org, topicSubPath, "duplicates");
        let type = findMostGranular2(this.config_org, topicSubPath, "type");
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
}  // MqttOrganization

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