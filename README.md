# Frugal IoT Logger

This is a library for a simple Mqtt Logger suitable for use with the Frugal IoT project.

Please see https://github.com/mitra42/frugal-iot for the full project. 

It should be able to work with any MQTT server that allows websocket connections,
but it is only (currently) tested against the Frugal-IoT mqtt server, 
which is mosquitto running at ws://naturalinnovation.org:9012

### Example of usage with expressjs 

The main example of the loggers use - that we test against - is currently 
in the main Frugal-IoT repo at 
https://github.com/mitra42/frugal-iot/blob/main/html/server/Main.js

This combines this Logger with a simple HTTP server to serve up the 
logged data and user interface.

This may move to its own repo frugal-iot-server at some point. 

### To install As a standalone server

Copy https://github.com/mitra42/frugal-iot-logger/examples/standalone
(Or clone the repo, or `npm install frugal-iot-logger`)

edit config.yaml # Make it match your hierarchy - note its fixed at 4 levels
```
node standalone.js
```

### Reporting problems

Complicated issues involving interaction between this repo 
and the frugal-iot client; nodes; or server should be posted
in https://github.com/mitr42/frugal-iot/issues 

### Use in other projects
While this project was designed for the needs of the Frugal-IoT project, 
which uses a Mosquitto server and has a particular pattern of topics, 
we would welcome PRs to make it more generically useful to other projects. 
After all - the more people find it useful - the more bugs will get fixed.
