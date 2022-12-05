import { createServer } from '@hive/service-common';
import { compress } from '@hive/usage-common';
import { processMessage } from '../src/ingestor';
import { createProcessor } from '../src/processor';
import { createWriter } from '../src/writer';

async function main() {
  const server = await createServer({
    name: 'benchmark-processing',
    tracing: false,
    log: {
      level: 'debug',
    },
  });

  const logger = server.log;
  const processor = createProcessor({ logger });
  const writer = createWriter({
    logger,
    clickhouse: {
      host: 'localhost',
      port: 8123,
      username: 'default',
      password: '',
      protocol: 'http',
      async_insert_busy_timeout_ms: 500,
      async_insert_max_data_size: 500,
    },
    clickhouseMirror: {
      host: 'localhost',
      port: 8123,
      username: 'default',
      password: '',
      protocol: 'http',
      async_insert_busy_timeout_ms: 500,
      async_insert_max_data_size: 500,
    },
    write: async () => {},
  });

  server.route<{
    Body: string;
  }>({
    method: 'POST',
    url: '/process-message',
    handler: async (req, res) => {
      try {
        await processMessage({
          logger,
          writer,
          processor,
          message: {
            value: await compress(req.body),
          },
        });
        res.status(200).send('OK');
      } catch (error: any) {
        res.status(500).send(error.message);
      }
    },
  });

  await server.listen(6969, '0.0.0.0');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
