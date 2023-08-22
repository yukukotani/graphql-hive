// query getTopProductsUp {
//   allProducts {
//     id
//   }
// }

import http from 'k6/http';

const endpoint = `http://localhost:4000`;

const query = `
  query getTopProductsUp {
    allProducts {
      id
    }
  }
`;

const operationName = 'getTopProductsUp';

const body = JSON.stringify({
  query,
  operationName,
});

export default () => {
  http.post(endpoint, body, {
    headers: {
      'Content-Type': 'application/json',
    },
  });
};
