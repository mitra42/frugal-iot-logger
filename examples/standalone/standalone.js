/*
  Standalone logger example

  Copy and edit config.yaml.example
 */
// import { MqttOrganization, MqttLogger } from "frugal-iot-logger";  // https://github.com/mitra42/frugal-iot-logger
import { MqttLogger } from "../../index.js";  // https://github.com/mitra42/frugal-iot-logger

let mqttLogger = new MqttLogger();

mqttLogger.readYamlConfig('.', (err, configobj) => {
    console.log("Logger Config=",configobj);
    mqttLogger.start(); // TODO-84 rename to start
  });

