import { readConfig } from './config.js';
import { createApp } from './app.js';

try {
  const config = readConfig();
  const listener = createApp(config).listen(config.MCP_PORT, config.MCP_HOST, () => console.log(JSON.stringify({ event: 'gateway_started', port: config.MCP_PORT })));
  listener.requestTimeout = 30000;
  listener.headersTimeout = 15000;
  listener.on('error', () => { console.error('Gateway listener failed'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
} catch {
  // Zod errors can contain supplied values. Never print config failures verbatim.
  console.error('Gateway configuration invalid. Check remote/.env.example and README.md.');
  process.exitCode = 1;
}
