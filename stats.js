var dgram  = require('dgram')
  , util   = require('util')
  , net    = require('net')
  , config = require('./config')

var counters = {};
var timers = {};
var debugInt, flushInt, server, mgmtServer;
var startup_time = Math.round(new Date().getTime() / 1000);

var stats = {
  graphite: {
    last_flush: startup_time,
    last_exception: startup_time
  },
  messages: {
    last_msg_seen: startup_time,
    bad_lines_seen: 0,
  }
};

config.configFile(process.argv[2], function (config, oldConfig) {
  if (! config.debug && debugInt) {
    clearInterval(debugInt); 
    debugInt = false;
  }

  if (config.debug) {
    if (debugInt !== undefined) { clearInterval(debugInt); }
    debugInt = setInterval(function () { 
      util.log("Counters:\n" + util.inspect(counters) + "\nTimers:\n" + util.inspect(timers));
    }, config.debugInterval || 10000);
  }

  if (server === undefined) {
    server = dgram.createSocket('udp4', function (msg, rinfo) {
      
      // for each message in the input, separated by newline
      var lines = msg.toString().split(/[\n\r]+/);
      for (var line_idx=0; line_idx<lines.length; line_idx++) {
        var line = lines[line_idx];
        if (config.dumpMessages) { util.log(line); }

        // split message by ':'. Format: key:value|type[:value|type]...
        var bits = line.split(':');
        var key = bits.shift()
                      .replace(/\s+/g, '_')
                      .replace(/\//g, '-')
                      .replace(/[^a-zA-Z_\-0-9\.]/g, '');

        // if we just got a key, assume a counter is incremented
        if (bits.length == 0) {
          bits.push("1|c");
        }

        // for each value
        for (var i = 0; i < bits.length; i++) {
          var sampleRate = 1;
          var fields = bits[i].split("|");
          if (fields[1] === undefined) {
              util.log('Bad line: ' + fields);
              stats['messages']['bad_lines_seen']++;
              continue;
          }
          
          // timers
          if (fields[1].trim() == "ms") {
            if (! timers[key]) {
              timers[key] = [];
            }
            timers[key].push(Number(fields[0] || 0));
            
          // counters
          } else {
            // is there a sample rate?
            if (fields[2] && fields[2].match(/^@([\d\.]+)/)) {
              sampleRate = Number(fields[2].match(/^@([\d\.]+)/)[1]);
            }
            if (! counters[key]) {
              counters[key] = 0;
            }
            counters[key] += Number(fields[0] || 1) * (1 / sampleRate);
          }
        }
      }

      stats['messages']['last_msg_seen'] = Math.round(new Date().getTime() / 1000);
    });

    mgmtServer = net.createServer(function(stream) {
      stream.setEncoding('ascii');

      stream.on('data', function(data) {
        var cmd = data.trim();

        switch(cmd) {
          case "help":
            stream.write("Commands: stats, counters, timers, quit\n\n");
            break;

          case "stats":
            var now    = Math.round(new Date().getTime() / 1000);
            var uptime = now - startup_time;

            stream.write("uptime: " + uptime + "\n");

            for (group in stats) {
              for (metric in stats[group]) {
                var val;

                if (metric.match("^last_")) {
                  val = now - stats[group][metric];
                }
                else {
                  val = stats[group][metric];
                }

                stream.write(group + "." + metric + ": " + val + "\n");
              }
            }
            stream.write("END\n\n");
            break;

          case "counters":
            stream.write(util.inspect(counters) + "\n");
            stream.write("END\n\n");
            break;

          case "timers":
            stream.write(util.inspect(timers) + "\n");
            stream.write("END\n\n");
            break;

          case "quit":
            stream.end();
            break;

          default:
            stream.write("ERROR\n");
            break;
        }

      });
    });

    server.bind(config.port || 8125);
    mgmtServer.listen(config.mgmt_port || 8126);

    var flushInterval = Number(config.flushInterval || 10000);

    flushInt = setInterval(function () {
      var statString = '';
      var ts = Math.round(new Date().getTime() / 1000);
      var numStats = 0;
      var key;

      for (key in counters) {
        var value = counters[key] / (flushInterval / 1000);
        var message = 'stats.' + key + ' ' + value + ' ' + ts + "\n";
        message += 'stats_counts.' + key + ' ' + counters[key] + ' ' + ts + "\n";
        statString += message;
        counters[key] = 0;

        numStats += 1;
      }

      for (key in timers) {
        if (timers[key].length > 0) {
          var pctThreshold = config.percentThreshold || 90;
          var values = timers[key].sort(function (a,b) { return a-b; });
          var count = values.length;
          var min = values[0];
          var max = values[count - 1];

          var mean = min;
          var maxAtThreshold = max;
          var sum = max;

          if (count > 1) {
            var thresholdIndex = Math.round(((100 - pctThreshold) / 100) * count);
            var numInThreshold = count - thresholdIndex;
            values = values.slice(0, numInThreshold);
            maxAtThreshold = values[numInThreshold - 1];

            // average the remaining timings
            sum = 0;
            for (var i = 0; i < numInThreshold; i++) {
              sum += values[i];
            }

            mean = sum / numInThreshold;
          }

          timers[key] = [];

          var message = "";
          message += 'stats.timers.' + key + '.mean ' + mean + ' ' + ts + "\n";
          message += 'stats.timers.' + key + '.upper ' + max + ' ' + ts + "\n";
          message += 'stats.timers.' + key + '.upper_' + pctThreshold + ' ' + maxAtThreshold + ' ' + ts + "\n";
          message += 'stats.timers.' + key + '.lower ' + min + ' ' + ts + "\n";
          message += 'stats.timers.' + key + '.count ' + count + ' ' + ts + "\n";
          message += 'stats.timers.' + key + '.sum ' + sum + ' ' + ts + "\n";
          statString += message;

          numStats += 1;
        }
      }

      statString += 'statsd.numStats ' + numStats + ' ' + ts + "\n";
      
      try {
        var graphite = net.createConnection(config.graphitePort, config.graphiteHost);
        graphite.addListener('error', function(connectionException){
          if (config.debug) {
            util.log(connectionException);
          }
        });
        graphite.on('connect', function() {
          this.write(statString);
          this.end();
          stats['graphite']['last_flush'] = Math.round(new Date().getTime() / 1000);
        });
      } catch(e){
        if (config.debug) {
          util.log(e);
        }
        stats['graphite']['last_exception'] = Math.round(new Date().getTime() / 1000);
      }

    }, flushInterval);
  }

});

