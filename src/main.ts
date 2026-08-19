import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';

const config = loadConfig();
const container = createContainer(config);
const server = createApp(container).listen(config.PORT, () => {
  process.stdout.write(`listening on http://localhost:${config.PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void container.database.close().then(() => process.exit(0));
    });
  });
}
