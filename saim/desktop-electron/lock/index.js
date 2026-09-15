// Platform lock-adapter selector. Each adapter exports { lock, wake, canOSLock, name }.
//   - win32 : real OS lock (LockWorkStation) + display wake for Windows Hello
//   - linux : no-op (the Pi kiosk's in-app LockScreen overlay IS the lock)
//   - other : no-op
switch (process.platform) {
  case 'win32':
    module.exports = require('./win32');
    break;
  case 'linux':
    module.exports = require('./linux');
    break;
  default:
    module.exports = require('./noop');
}
