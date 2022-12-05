import { performance } from 'perf_hooks';
import { createHash } from 'crypto';
import { compress, decompress } from './compression';
import { Message, RawReport, RawOperation, RawOperationMapRecord } from './gen/message';
import assert from 'assert';

function createRandomHash() {
  return createHash('sha256').update(Math.random().toString()).digest('hex');
}

function createRandomReport(): RawReport {
  const operations: RawOperation[] = [];
  const operationMap: Record<string, RawOperationMapRecord> = {};

  for (let i = 0; i < 10; i++) {
    const opKey = createRandomHash();

    operationMap[opKey] = {
      key: opKey,
      operationName: createRandomHash(),
      operation: `query ${createRandomHash()} { ${createRandomHash()} }`,
      fields: ['Query', 'Mutation', 'Subscription'],
    };

    for (let j = 0; j < 30; j++) {
      operations.push({
        operationMapKey: opKey,
        timestamp: Math.floor(Date.now() / 1000),
        execution: {
          ok: true,
          duration: 100 as any,
          errorsTotal: 0,
        },
      });
    }
  }

  return {
    id: createRandomHash(),
    size: 300,
    target: createRandomHash(),
    map: operationMap,
    operations,
  };
}

// Simple structure
// CODE_SIZE
//
// proto 12.99016600009054 ms
// json 74.09666700009257 ms
// bytes 10
// bytes 55
//
// SPEED
//
// proto 8.760207999497652 ms
// json 74.89087500050664 ms
// bytes 10
// bytes 55

// Heavy structure
// CODE_SIZE
//
// proto 5.868157292000018 ms
// json 3.5723711249998304 ms
// proto bytes 5985
// json bytes 7008
//
// SPEED
// proto 5.3424023749995975 ms
// json 3.6729104999997655 ms
// proto bytes 5973
// json bytes 7007

async function proto(size = false) {
  const org = {
    reports: [createRandomReport(), createRandomReport(), createRandomReport()],
  };
  const start = performance.now();
  const bytes = await compress(Message.toBinary(org));

  if (size) {
    console.log('proto bytes', bytes.length);
  }

  const msg = Message.fromBinary(await decompress(bytes));

  const end = performance.now();

  assert.deepEqual(msg, org);

  return end - start;
}

async function json(size = false) {
  const org = {
    reports: [createRandomReport(), createRandomReport(), createRandomReport()],
  };
  const start = performance.now();
  const bytes = await compress(JSON.stringify(org));

  if (size) {
    console.log('json bytes', bytes.length);
  }

  const msg = JSON.parse((await decompress(bytes)).toString());
  const end = performance.now();

  assert.deepEqual(msg, org);

  return end - start;
}

async function main() {
  const list = Array(1000).fill(null);

  // run proto 1000 times
  const protoTimes: number[] = [];
  for await (const _ of list) {
    protoTimes.push(await proto());
  }

  // run proto 1000 times
  const jsonTimes: number[] = [];
  for await (const _ of list) {
    jsonTimes.push(await json());
  }

  const avgProtoTime = protoTimes.reduce((a, b) => a + b, 0) / protoTimes.length;
  const avgJsonTime = jsonTimes.reduce((a, b) => a + b, 0) / jsonTimes.length;

  // print results in ms
  console.log('proto', avgProtoTime, 'ms');
  console.log('json', avgJsonTime, 'ms');

  await proto(true);
  await json(true);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
