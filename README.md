# Frugal IoT Logger

This is a library for a simple Mqtt Logger suitable for use with the Frugal IoT project.

Please see https://github.com/mitra42/frugal-iot for the full project. 

It should be able to work with any MQTT server that allows websocket connections,
but it is only (currently) tested against the Frugal-IoT mqtt server, 
which is mosquitto running at ws://naturalinnovation.org:9012

The default behavior of the frugal-iot-logger is to store to CSV
files in a format that can be retrieved by frugal-iot-client or used for
other analysis.

It can also be used with Google Spreadsheets (aka gsheets)

### Example of usage with expressjs 

The main example of the loggers use - that we test against - is in the 
[frugal-iot-server repo](https://github.com/mitra42/frugal-iot-server)

This combines this Logger with a simple HTTP server to serve up the 
logged data and user interface.

### To install As a standalone server

Copy https://github.com/mitra42/frugal-iot-logger/examples/standalone
(Or clone the repo, or `npm install frugal-iot-logger`)

edit `config.yaml` 
and in `config.d/organizations` put a yaml file for your org, using the example in 
`examples/standalone/config.d/organizations/dev.yaml`
Make it match your hierarchy but note its fixed at 4 levels   organization, project, node, topic
```
node standalone.js
```

#### Google Spreadsheets
Simple usage with Google spreadsheets is supported.  This requires an addition to
an organization's config file (e.g. `dev.yaml`) with a reference to the app URL
and the list of topics that should be logged to the columns.

A full example is in `examples/gsheets`, look at `gsheet.app` for instructions on 
setting up a spreadsheet, and at `config.d/organizations/dev.yaml`->`gsheets` for 
how to configure it.

#### Firebase Integration
Automatic upload of MQTT data to Firebase Realtime Database is supported. This allows
real-time data access, cloud storage, and easy integration with web/mobile apps.

To enable Firebase:
1. Add a `firebase` section to your organization config (e.g. `dev.yaml`)
2. Provide your Firebase service account JSON and database URL
3. Data is automatically uploaded as it arrives via MQTT

**Complete documentation and example:** [examples/firebase/README.md](examples/firebase/README.md)

### Reporting problems

Complicated issues involving interaction between this repo 
and the frugal-iot client; nodes; or server should be posted
in https://github.com/mitr42/frugal-iot/issues 

### Use in other projects
While this project was designed for the needs of the Frugal-IoT project, 
which uses a Mosquitto server and has a particular pattern of topics, 
we would welcome PRs to make it more generically useful to other projects. 
After all - the more people find it useful - the more bugs will get fixed.
