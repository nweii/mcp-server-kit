// Process entry and shutdown helpers: start listening and persist state on SIGTERM/SIGINT so a
// container restart doesn't lose in-memory data (e.g. issued tokens) that a shutdown hook writes.
import type { Express } from 'express';
import type { Server } from 'http';

export interface StartServerOptions {
  app: Express;
  port: number;
  // Bind address; defaults to 0.0.0.0 so the server is reachable inside a container.
  host?: string;
  // Runs once the server is listening. Defaults to a one-line console log.
  onListen?: () => void;
  // Runs on SIGTERM/SIGINT before the process exits. Persist state here; may be async.
  onShutdown?: () => void | Promise<void>;
}

export function startServer(opts: StartServerOptions): Server {
  const host = opts.host ?? '0.0.0.0';
  const server = opts.app.listen(opts.port, host, () => {
    if (opts.onListen) opts.onListen();
    else console.log(`listening on port ${opts.port}`);
  });

  const shutdown = async () => {
    try {
      if (opts.onShutdown) await opts.onShutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}
