import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '30s', target: 100 },
    { duration: '10s', target: 0 },
  ],
};

const BASE_URL = 'http://0.0.0.0:6969';

const report = JSON.stringify([
  {
    id: '1234',
    size: 2,
    target: 'target-1',
    map: {
      'op-1': {
        key: 'op-1',
        operation: 'query op1 { me { id name } }',
        operationName: 'op1',
        fields: ['Query', 'User', 'Query.me', 'User.id', 'User.name'],
      },
      'op-2': {
        key: 'op-2',
        operation: 'query op2 { me { id } }',
        operationName: 'op2',
        fields: ['Query', 'User', 'Query.me', 'User.id'],
      },
    },
    operations: [
      {
        operationMapKey: 'op-1',
        timestamp: Date.now(),
        execution: {
          ok: true,
          duration: Date.now(),
          errorsTotal: 0,
        },
        metadata: {
          client: {
            name: 'client-name',
            version: 'client-version',
          },
        },
      },
      {
        operationMapKey: 'op-2',
        timestamp: Date.now(),
        execution: {
          ok: true,
          duration: Date.now(),
          errorsTotal: 0,
        },
        metadata: {
          client: {
            name: 'client-name',
            version: 'client-version',
          },
        },
      },
    ],
  },
]);

export default () => {
  http.post(`${BASE_URL}/process-message`, report, {
    headers: {
      'content-type': 'text/plain',
    },
  });

  sleep(1);
};
