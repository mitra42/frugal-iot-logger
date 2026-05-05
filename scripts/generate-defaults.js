#!/usr/bin/env node

/**
 * Generate C header file with default values from schema
 *
 * This script reads the YAML configuration and extracts default values
 * for configurable fields (color, min, max) from the module schemas.
 * It generates a defaults.h file suitable for embedding in the frugal-iot firmware.
 *
 * Usage: node generate-defaults.js [config-path]
 */

import { MqttLogger } from '../index.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// Fields to extract from the schema
const FIELDS_TO_EXTRACT = ['color', 'min', 'max'];
// Default to ../frugal-iot-server config if it exists, otherwise use ./config
const DEFAULT_CONFIG_PATH = resolve(__dirname, '../../frugal-iot-server');
const CONFIG_PATH = process.argv[2] || DEFAULT_CONFIG_PATH;
const OUTPUT_FILE = resolve(__dirname, '../defaults.h');

/**
 * Convert field names to valid C macro names
 * sht/temperature -> sht_temperature
 */
function toMacroName(fieldName) {
  return fieldName.replace(/\//g, '_').replace(/-/g, '_');
}

/**
 * Convert value to C macro format
 */
function formatValue(value) {
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  return String(value);
}

/**
 * Convert frugal-iot type to C type
 */
function toCType(frugalType) {
  const typeMap = {
    'bool': 'uint8_t',
    'int': 'int32_t',
    'float': 'float',
    'text': 'const char*',
    'topic': 'const char*',
    'color': 'const char*',
    'yaml': 'const char*'
  };
  return typeMap[frugalType] || 'float';
}

/**
 * Generate C define statement
 */
function generateDefine(moduleName, fieldName, attribute, value) {
  const safeModuleName = toMacroName(moduleName);
  const safeFieldName = toMacroName(fieldName);
  const macroName = `DEFAULT_${safeModuleName}_${safeFieldName}_${attribute}`;
  const formattedValue = formatValue(value);
  return `#define ${macroName} ${formattedValue}`;
}

/**
 * Main function to generate defaults
 */
async function generateDefaults() {
  try {
    // Create logger instance (don't start it)
    const logger = new MqttLogger();

    // Read configuration
    console.log(`Reading configuration from ${CONFIG_PATH}...`);
    const config = await new Promise((resolve, reject) => {
      logger.readYamlConfig(CONFIG_PATH, (err, config) => {
        if (err) {
          reject(err);
        } else {
          resolve(config);
        }
      });
    });

    console.log('Configuration loaded successfully');

    // Collect all defines
    const defines = [];
    const comments = [];
    const typeInfo = {};

    // Get all module names from schema
    if (!config.schema || !config.schema.modules) {
      console.error('No schema.modules found in configuration');
      process.exit(1);
    }

    const modules = Object.keys(config.schema.modules);
    console.log(`Found ${modules.length} modules: ${modules.join(', ')}`);

    // Process each module
    for (const moduleName of modules) {
      const moduleSchema = config.schema.modules[moduleName];

      if (!moduleSchema.topics || moduleSchema.topics.length === 0) {
        console.log(`  Skipping module "${moduleName}" - no topics defined`);
        continue;
      }

      console.log(`\nProcessing module: ${moduleName}`);

      // Process each topic in the module
      for (const topicDef of moduleSchema.topics) {
        const fieldName = topicDef.leaf;
        const topicLeaf = topicDef.leaf_from || fieldName;
        const topicSchema = config.schema.topics[topicLeaf];

        // Store type info for later
        const fieldType = topicDef.type || (topicSchema && topicSchema.type) || 'float';
        const macroFieldName = toMacroName(`${moduleName}/${fieldName}`);
        typeInfo[macroFieldName] = fieldType;

        console.log(`  Topic: ${fieldName}`);

        // Process each field we're extracting (color, min, max, etc.)
        for (const attribute of FIELDS_TO_EXTRACT) {
          let value = topicDef[attribute];

          // If not in topicDef, try topicSchema
          if (value === undefined && topicSchema) {
            // Map 'min' -> 'minimum', 'max' -> 'maximum' for schema lookup
            //const schemaAttribute = attribute === 'min' ? 'minimum' :
            //                       attribute === 'max' ? 'maximum' : attribute;
            const schemaAttribute = attribute;
            value = topicSchema[schemaAttribute];
          }

          if (value !== undefined && value !== null) {
            const define = generateDefine(moduleName, fieldName, attribute, value);
            defines.push(define);
            console.log(`    ${attribute}: ${define}`);
          }
        }
      }
    }

    // Build the header file content
    let headerContent = '// This file is intended to go in src/defaults.h in the frugal-iot repo\n';
    headerContent += '// Auto-generated by generate-defaults.js\n';
    headerContent += `// Generated: ${new Date().toISOString()}\n`;
    headerContent += '\n';
    headerContent += '#ifndef DEFAULTS_H\n';
    headerContent += '#define DEFAULTS_H\n';
    headerContent += '\n';
    headerContent += defines.join('\n');
    headerContent += '\n\n';
    headerContent += '#endif // DEFAULTS_H\n';

    // Write to file
    console.log(`\nWriting ${defines.length} defines to ${OUTPUT_FILE}...`);
    await writeFile(OUTPUT_FILE, headerContent, 'utf8');
    console.log(`✓ Successfully wrote to ${OUTPUT_FILE}`);
    console.log(`\nTip: Copy this file to src/defaults.h in the frugal-iot firmware repository.`);

  } catch (error) {
    console.error('Error generating defaults:', error);
    process.exit(1);
  }
}

// Run the script
generateDefaults();

