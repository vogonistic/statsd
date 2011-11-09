var fs   = require('fs')
  , util = require('util')

var Configurator = function (file) {

  var self = this;
  var config = {};
  var oldConfig = {};

  this.updateConfig = function () {
    util.log('reading config file: ' + file);

    fs.readFile(file, function (err, data) {
      if (err) { throw err; }
      old_config = self.config;

      // QD remove comments and parse JSON
      new_config = JSON.parse(data.toString().replace(/(#|\/\/).*$/mg, ''))
      
      self.oldConfig = self.config;
      self.config = new_config;
      self.emit('configChanged', self.config);
    });
  };

  this.updateConfig();

  fs.watchFile(file, function (curr, prev) {
    if (curr.ino != prev.ino) { self.updateConfig(); }
  });
};

util.inherits(Configurator, process.EventEmitter);

exports.Configurator = Configurator;

exports.configFile = function(file, callbackFunc) {
  var config = new Configurator(file);
  config.on('configChanged', function() {
    callbackFunc(config.config, config.oldConfig);
  });
};

