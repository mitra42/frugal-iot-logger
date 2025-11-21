import { MqttLogger } from '../../index.js';

const logger = new MqttLogger();

logger.readYamlConfig('.', (err, config) => {
  if (err) {
    console.error('Error reading config:', err);
    process.exit(1);
  }
  console.log('Config loaded, starting logger with Firebase integration...');
  logger.start();
});