/*
  Standalone logger example

  Copy and edit config.yaml.example
 */
// import { MqttOrganization, MqttLogger } from "frugal-iot-logger";  // https://github.com/mitra42/frugal-iot-logger
import { MqttLogger } from "../../index.js";  // https://github.com/mitra42/frugal-iot-logger

let mqttLogger = new MqttLogger();

mqttLogger.readYamlConfig('.', (err, configobj) => {
  if (err) {
    console.error('Error reading config:', err);
    process.exit(1);
  }
  console.log("Logger Config=",configobj);
    mqttLogger.start();
  });

