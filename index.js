/*
 * Basic Logger for the Frugal IoT project
 *
 * Intended to be run as part of a HTTP server but could be run standalone
 *
 */

import async from 'async'; // https://caolan.github.io/async/v3/docs.html
import yaml from 'js-yaml'; // https://www.npmjs.com/package/js-yaml
import { appendFile, mkdir, readFile } from "fs"; // https://nodejs.org/api/fs.html
import mqtt from 'mqtt'; // https://www.npmjs.com/package/mqtt

// =========== Some generic helper functions, not specific to this client ========
// Clean any leading "/" or "../" from a string so it can be safely appended to a path
function sanitizeUrl(t) {
  if(t && t[0] === '/') { return sanitizeUrl(t.substring(1)); }
  return (t.replaceAll("../",""));
}


// ================== MQTT Client embedded in server ========================

// Manages a connection to a broker - each organization needs its own connection
class MqttOrganization {
  constructor(config_org, config_mqtt) {
    this.config_org = config_org; // Config structure currently: { name, mqtt_password, projects[ {name, track[]}]}
    this.config_mqtt = config_mqtt; // { broker }
    this.mqtt_client = null; // Object from library
    this.subscriptions = []; // [{topic, qos, cb(topic, message)}]
    this.status = "constructing";
  }

  mqtt_status_set(k) {
    console.log('mqtt', this.config_org.name, k);
    this.status = k;
  }

  startClient() {
    if (!this.mqtt_client) {
      // See https://stackoverflow.com/questions/69709461/mqtt-websocket-connection-failed
      // TODO-41 handle multiple projects -> multiple mqtt sessions
      this.mqtt_status_set("connecting");
      // TODO go thru the options at https://www.npmjs.com/package/mqtt#client-connect and check optimal
      // noinspection JSUnresolvedReference
      this.mqtt_client = mqtt.connect(this.config_mqtt.broker, {
        connectTimeout: 5000,
        username: this.config_org.userid || this.config_org.name,
        password: this.config_org.mqtt_password,
        // Remainder do not appear to be needed
        //hostname: "127.0.0.1",
        //port: 9012, // Has to be configured in mosquitto configuration
        //path: "/mqtt",
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
    this.mqtt_client.subscribe(topic, {qos: qos}, this.subErr);
  }

  subscribe(topic, qos, cb) {
    this.mqtt_subscribe(topic, qos);
    this.subscriptions.push({topic, qos, cb});
  }

  configSubscribe() {
    // noinspection JSUnresolvedReference
    for (let p of this.config_org.projects) {
      for (let n of p.nodes) { // Note that node could have name of '+' for tracking all of them
        for (let t of n.track) {
          let topic = `${this.config_org.name}/${p.name}/${n.id}/${t}`;
          // TODO-server for now its a generic messageReceived - may need some kind of action - for example if Config had a "control" rule
          this.subscribe(topic, 0, this.messageReceived.bind(this)); // TODO-66 think about QOS, add optional in YAML
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
    for (let sub of this.subscriptions) {
      if (sub.topic === topic) {
        sub.cb(topic, message);
      }
    }
  }
  // Find where in the config is the most detailed response e.g. the field on the project will be overridden by one on a topic.
  findMostGranular(topicpath, field) {
    // noinspection JSUnusedLocalSymbols
    let [org, project, node, topic] = topicpath.split('/');
    let o = this.config_org;
    let p,n,t,f;
    // noinspection JSUnresolvedReference
    if (p = o.projects.find((pp) => pp.name === project)) {
      if (n = p.nodes.find((nn) => nn.id === node)) {
        /* TODO-4 when reorganize then could have a field on a track
        if (t = n.track.find((nn) => nn.name === topic) {
          [topic]) {
          if (f = t[field]) { return f; }
        }
        */
        if (f = n[field]) { return f; }
      }
      if (f = p[field]) { return f; }
    }
    if (o[field]) { return f;}
    return null;
  }
  duplicate(topic, message) {
    // First find the duplicate rules for the topic
    let rules = this.findMostGranular(topic, "duplicates");
    console.log("xxx rules for ", topic, "=", rules);
    // TODO-3 found rules above, now apply them, then add more complex ones
    return false;
  }
  messageReceived(topic, message) {
    if (!this.duplicate(topic, message)) {
      this.log(topic, message);
    }
  }
  log(topic, message) {
    let path = `data/${sanitizeUrl(topic)}`;
    let dateNow = new Date();
    let filename = `${dateNow.toISOString().substring(0, 10)}.csv`
    this.appendPathFile(path, filename, `${dateNow.valueOf()},"${message}"\n`);
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
    this.clients = [];
    let config;
  }
  // TODO The readYamlConfig probably belongs elsewhere, like in the caller.
  readYamlConfig(inputFilePathOrDescriptor, cb) {
    // Read configuration file and return object
    async.waterfall([
        (cb) => readFile(inputFilePathOrDescriptor, 'utf8', cb),
        (yamldata, cb) => cb(null, yaml.load(yamldata, {onWarning: (warn) => console.log('Yaml warning:', warn)})),
        (config, cb) => { this.config = config; cb(null, config); }
      ],
      cb
    );
  }
  start() {
    // noinspection JSUnresolvedReference
    for (let o of this.config.organizations) {
      let c = new MqttOrganization(o, this.config.mqtt); // Will subscribe when connects
      this.clients.push(c);
      c.startClient();
    }
  }
}

export { MqttLogger, MqttOrganization };