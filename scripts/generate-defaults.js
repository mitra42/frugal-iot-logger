#!/usr/bin/env node

/**
 * Generate C header file with default values from schema
 *
 * This script reads the YAML configuration and extracts default values
 * for configurable fields (color, min, max) from the module schemas.
 * It generates a defaults.h file suitable for embedding in the frugal-iot firmware.
 *
 * Usage: node generate-defaults.js [-q|--quiet] [config-path]
 *
 * -q (--quiet) prints nothing unless something is wrong, so it can run from a release script
 * without burying the one line that matters.
 *
 * Rerunning this on an unchanged schema leaves defaults.h byte for byte as it was, and says so -
 * the file carries no timestamp, precisely so that a release that changed nothing shows up as a
 * repository with nothing to commit rather than as a one-line diff nobody can interpret.
 */

import { MqttLogger } from '../index.js';
import { writeFile, readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// Fields to extract from the schema
const FIELDS_TO_EXTRACT = ['color', 'min', 'max'];
// Default to ../frugal-iot-server config if it exists, otherwise use ./config
const DEFAULT_CONFIG_PATH = resolve(__dirname, '../../frugal-iot-server');
const ARGV = process.argv.slice(2);
const QUIET = ARGV.includes('-q') || ARGV.includes('--quiet');
const CONFIG_PATH = ARGV.find((a) => !a.startsWith('-')) || DEFAULT_CONFIG_PATH;
const OUTPUT_FILE = resolve(__dirname, '../defaults.h');

// Progress, as opposed to a problem: silent under -q. Anything wrong goes to console.error, which
// is never silenced, so a quiet run that prints is a quiet run that found something.
function say(...args) {
  if (!QUIET) console.log(...args);
}

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

    // Read configuration.
    // readYamlConfig names every file it opens on console.log. That is wanted when the server
    // starts up and unwanted here, so under -q the logging is muted around the call rather than
    // changed in index.js, where the server is relying on it. console.error is left alone, so a
    // failure still has somewhere to go.
    say(`Reading configuration from ${CONFIG_PATH}...`);
    const realLog = console.log;
    if (QUIET) console.log = () => {};
    let config;
    try {
      config = await new Promise((resolve, reject) => {
        logger.readYamlConfig(CONFIG_PATH, (err, cfg) => {
          if (err) {
            reject(err);
          } else {
            resolve(cfg);
          }
        });
      });
    } finally {
      console.log = realLog;
    }

    say('Configuration loaded successfully');

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
    say(`Found ${modules.length} modules: ${modules.join(', ')}`);

    // Process each module
    for (const moduleName of modules) {
      const moduleSchema = config.schema.modules[moduleName];

      if (!moduleSchema.topics || moduleSchema.topics.length === 0) {
        say(`  Skipping module "${moduleName}" - no topics defined`);
        continue;
      }

      say(`\nProcessing module: ${moduleName}`);

      // Process each topic in the module
      for (const topicDef of moduleSchema.topics) {
        const fieldName = topicDef.leaf;
        const topicLeaf = topicDef.leaf_from || fieldName;
        const topicSchema = config.schema.topics[topicLeaf];

        // Store type info for later
        const fieldType = topicDef.type || (topicSchema && topicSchema.type) || 'float';
        const macroFieldName = toMacroName(`${moduleName}/${fieldName}`);
        typeInfo[macroFieldName] = fieldType;

        say(`  Topic: ${fieldName}`);

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
            say(`    ${attribute}: ${define}`);
          }
        }
      }
    }

    // Build the header file content
    let headerContent = '// This file is intended to go in src/defaults.h in the frugal-iot repo\n';
    headerContent += '// Auto-generated by generate-defaults.js\n';
    headerContent += '\n';
    headerContent += '#ifndef DEFAULTS_H\n';
    headerContent += '#define DEFAULTS_H\n';
    headerContent += '\n';
    headerContent += defines.join('\n');
    headerContent += '\n\n';
    headerContent += '#endif // DEFAULTS_H\n';

    // Only write when the content actually differs, so a release that changed no schema leaves
    // the checkout clean instead of handing you a file to commit that says the same as before.
    const existing = await readFile(OUTPUT_FILE, 'utf8').catch(() => null);
    if (existing === headerContent) {
      say(`\n${defines.length} defines - ${OUTPUT_FILE} is already up to date`);
    } else {
      await writeFile(OUTPUT_FILE, headerContent, 'utf8');
      say(`\n✓ Wrote ${defines.length} defines to ${OUTPUT_FILE}`);
      say(`\nTip: Copy this file to src/defaults.h in the frugal-iot firmware repository.`);
    }

  } catch (error) {
    console.error('Error generating defaults:', error);
    process.exit(1);
  }
}

// Run the script
generateDefaults();

